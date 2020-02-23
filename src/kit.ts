/**
 * Module for controlling and working with Kits.
 */ /** */

import rollbar from '@cmt/rollbar';
import * as util from '@cmt/util';
import * as json5 from 'json5';
import * as path from 'path';
import * as vscode from 'vscode';

import {VSInstallation, vsInstallations} from './installs/visual-studio';
import * as expand from './expand';
import * as logging from './logging';
import paths from './paths';
import {fs} from './pr';
import * as proc from './proc';
import {loadSchema} from './schema';
import {compare, dropNulls, objectPairs, Ordering} from './util';
import * as nls from 'vscode-nls';

nls.config({ messageFormat: nls.MessageFormat.bundle, bundleFormat: nls.BundleFormat.standalone })();
const localize: nls.LocalizeFunc = nls.loadMessageBundle();

const log = logging.createLogger('kit');

/**
 * Special kit types and names
 */
export enum SpecialKits {
  ScanForKits = '__scanforkits__',
  Unspecified = '__unspec__'
}
export const SpecialKitsCount: number = 2;
export type UnspecifiedKit = SpecialKits.Unspecified;

type ProgressReporter = vscode.Progress<{message?: string}>;

/**
 * The path to the user-local kits file.
 */
export const USER_KITS_FILEPATH = path.join(paths.dataDir, 'cmake-tools-kits.json');

/**
 * The old path where kits were stored. Upgraded in 1.1.3
 */
export const OLD_USER_KITS_FILEPATH
    = path.join(process.platform === 'win32' ? paths.roamingDataDir : paths.dataDir, 'cmake-tools.json');

/**
 * Representation of a CMake generator, along with a toolset and platform
 */
export interface CMakeGenerator {
  name: string;
  toolset?: string;
  platform?: string;
}

export interface Kit {
  /**
   * The name of the kit
   */
  name: string;

  /**
   * The preferred CMake generator for this kit
   */
  preferredGenerator?: CMakeGenerator;

  /**
   * Additional settings to pass to CMake
   */
  cmakeSettings?: {[key: string]: string};

  /**
   * Additional environment variables for the kit
   */
  environmentVariables?: proc.EnvironmentVariables;

  /**
   * The language compilers.
   *
   * The key `lang` is the language, as in `CMAKE_<lang>_COMPILER`.
   * The corresponding value is a path to a compiler for that language.
   */
  compilers?: {[lang: string]: string};

  /**
   * The visual studio name. This corresponds to the major.minor version of
   * the installation returned by `vswhere`.
   */
  visualStudio?: string;

  /**
   * The architecture for the kit. This is used when asking for the architecture
   * from the dev environment batch file.
   */
  visualStudioArchitecture?: string;

  /**
   * Path to a CMake toolchain file.
   */
  toolchainFile?: string;

  /**
   * If `true`, keep this kit around even if it seems out-of-date
   */
  keep?: boolean;
}

interface ClangVersion {
  fullVersion: string;
  version: string;
  target?: string;
  threadModel?: string;
  installedDir?: string;
}

async function getClangVersion(binPath: string): Promise<ClangVersion|null> {
  log.debug(localize('testing.clang.binary', 'Testing Clang binary: {0}', binPath));
  const exec = await proc.execute(binPath, ['-v']).result;
  if (exec.retc !== 0) {
    log.debug(localize('bad.clang.binary', 'Bad Clang binary ("-v" returns non-zero): {0}', binPath));
    return null;
  }
  const lines = exec.stderr.split('\n');
  const version_re = /^(?:Apple LLVM|Apple clang|clang) version ([^\s-]+)[\s-]/;
  let version: string = "";
  let fullVersion: string = "";
  for (const line of lines) {
    const version_match = version_re.exec(line);
    if (version_match !== null) {
      version = version_match[1];
      fullVersion = line;
      break;
    }
  }
  if (!version) {
    log.debug(localize('bad.clang.binary.output', 'Bad Clang binary {0} -v output: {1}', binPath, exec.stderr));
    return null;
  }
  const target_mat = /Target:\s+(.*)/.exec(exec.stderr);
  let target: string|undefined;
  if (target_mat) {
    target = target_mat[1];
  }
  const thread_model_mat = /Thread model:\s+(.*)/.exec(exec.stderr);
  let threadModel: string|undefined;
  if (thread_model_mat) {
    threadModel = thread_model_mat[1];
  }
  const install_dir_mat = /InstalledDir:\s+(.*)/.exec(exec.stderr);
  let installedDir: string|undefined;
  if (install_dir_mat) {
    installedDir = install_dir_mat[1];
  }
  return {
    fullVersion,
    version,
    target,
    threadModel,
    installedDir,
  };
}

/**
 * Convert a binary (by path) to a CompilerKit. This checks if the named binary
 * is a GCC or Clang compiler and gets its version. If it is not a compiler,
 * returns `null`.
 * @param bin Path to a binary
 * @returns A CompilerKit, or null if `bin` is not a known compiler
 */
export async function kitIfCompiler(bin: string, pr?: ProgressReporter): Promise<Kit|null> {
  const fname = path.basename(bin);
  // Check by filename what the compiler might be. This is just heuristic.
  const gcc_regex = /^((\w+-)*)gcc(-\d+(\.\d+(\.\d+)?)?)?(\.exe)?$/;
  const clang_regex = /^clang(-\d+(\.\d+(\.\d+)?)?)?(\.exe)?$/;
  const gcc_res = gcc_regex.exec(fname);
  const clang_res = clang_regex.exec(fname);
  if (gcc_res) {
    log.debug(localize('testing.gcc.binary', 'Testing GCC binary: {0}', bin));
    if (pr)
      pr.report({message: localize('getting.gcc.version', 'Getting GCC version for {0}', bin)});
    const exec = await proc.execute(bin, ['-v']).result;
    if (exec.retc !== 0) {
      log.debug(localize('bad.gcc.binary', 'Bad GCC binary ("-v" returns non-zero): {0}', bin));
      return null;
    }

    const compiler_version_output = exec.stderr.trim().split('\n');
    const version_re = /^gcc version (.*?) .*/;
    let version: string = "";
    for (const line of compiler_version_output) {
      const version_match = version_re.exec(line);
      if (version_match !== null) {
        version = version_match[1];
        break;
      }
    }
    if (!version) {
      log.debug(localize('bad.gcc.binary.output', 'Bad GCC binary {0} -v output: {1}', bin, exec.stderr));
      return null;
    }
    const gxx_fname = fname.replace(/gcc/, 'g++');
    const gxx_bin = path.join(path.dirname(bin), gxx_fname);
    const target_triple_re = /((\w+-)+)gcc.*/;
    const target_triple_match = target_triple_re.exec(fname);
    let description = '';
    if (target_triple_match !== null) {
      description += `for ${target_triple_match[1].slice(0, -1)} `;
    }
    const name = `GCC ${description}${version}`;
    log.debug(localize('detected.gcc.compiler', 'Detected GCC compiler: {0}', bin));
    let gccKit: Kit = {
      name,
      compilers: {
        C: bin,
      }
    };

    if (await fs.exists(gxx_bin)) {
      gccKit = {name, compilers: {C: bin, CXX: gxx_bin}};
    }

    const isWin32 = process.platform === 'win32';
    if (isWin32 && bin.toLowerCase().includes('mingw')) {
      const binParentPath = path.dirname(bin);
      const mingwMakePath = path.join(binParentPath, 'mingw32-make.exe');
      if (await fs.exists(mingwMakePath)) {
        // During a scan, binParentPath must be a directory already in the PATH.
        // Therefore, we will assume that MinGW will remain in the user's PATH
        // and do not need to record the current state of PATH (leave it to the
        // user to rescan later or specify an explicit path to MinGW if this
        // changes).  Additionally, caching the current state of PATH can cause
        // complications on later invocation when using the kit environment
        // because its PATH will take precedence.  If a user makes changes to
        // their PATH later without rescanning for kits, then the kit's cached
        // PATH will clobber the actual current PATH.  We will, however, record
        // the MinGW path in case we want to use it later.
        const ENV_PATH = `${binParentPath}`;
        // Check for working mingw32-make
        const execMake = await proc.execute(mingwMakePath, ['-v'], null, {environment: {PATH: ENV_PATH}}).result;
        if (execMake.retc !== 0) {
          log.debug(localize('bad.mingw32-make.binary', 'Bad mingw32-make binary ("-v" returns non-zero): {0}', bin));
        } else {
          let make_version_output = execMake.stdout;
          if (make_version_output.length === 0)
            make_version_output = execMake.stderr;
          const output_line_sep = make_version_output.trim().split('\n');
          const isMake = output_line_sep[0].includes('Make');
          const isMingwTool = output_line_sep[1].includes('mingw32');

          if (isMake && isMingwTool) {
            gccKit.preferredGenerator = {name: 'MinGW Makefiles'};
            // save the ENV_PATH as a benign name unlikely to already exist in
            // the user's environment, like CMT_MINGW_PATH
            gccKit.environmentVariables = {CMT_MINGW_PATH: ENV_PATH};
          }
        }
      }
    }
    return gccKit;

  } else if (clang_res) {
    log.debug(localize('testing.clang.binary', 'Testing Clang binary: {0}', bin));
    if (pr)
      pr.report({message: localize('getting.clang.version', 'Getting Clang version for {0}', bin)});
    const version = await getClangVersion(bin);
    if (version === null) {
      return null;
    }
    if (version.target && version.target.includes('msvc')) {
      // DO NOT include Clang's that target MSVC but don't present the MSVC
      // command-line interface. CMake does not support them properly.
      return null;
    }
    const clangxx_fname = fname.replace(/^clang/, 'clang++');
    const clangxx_bin = path.join(path.dirname(bin), clangxx_fname);
    const name = `Clang ${version.version}`;
    log.debug(localize('detected.clang.compiler', 'Detected Clang compiler: {0}', bin));
    if (await fs.exists(clangxx_bin)) {
      return {
        name,
        compilers: {
          C: bin,
          CXX: clangxx_bin,
        },
      };
    } else {
      return {
        name,
        compilers: {
          C: bin,
        },
      };
    }
  } else {
    return null;
  }
}

async function scanDirectory<Ret>(dir: string, mapper: (filePath: string) => Promise<Ret|null>): Promise<Ret[]> {
  if (!await fs.exists(dir)) {
    log.debug(localize('skipping.scan.of.not.existing.path', 'Skipping scan of not existing path {0}', dir));
    return [];
  }

  log.debug(localize('scanning.directory.for.compilers', 'Scanning directory {0} for compilers', dir));
  try {
    const stat = await fs.stat(dir);
    if (!stat.isDirectory()) {
      console.log('Skipping scan of non-directory', dir);
      return [];
    }
  } catch (e) {
    log.warning(localize('failed.to.scan', 'Failed to scan {0} by exception: {1}', dir, e));
    if (e.code == 'ENOENT') {
      return [];
    }
    throw e;
  }

  // Get files in the directory
  let bins: string[];
  try {
    bins = (await fs.readdir(dir)).map(f => path.join(dir, f));
  } catch (e) {
    if (e.code == 'EACCESS' || e.code == 'EPERM') {
      return [];
    }
    throw e;
  }

  const prs = await Promise.all(bins.map(b => mapper(b)));
  return dropNulls(prs);
}

/**
 * Scans a directory for compiler binaries.
 * @param dir Directory containing candidate binaries
 * @returns A list of CompilerKits found
 */
export async function scanDirForCompilerKits(dir: string, pr?: ProgressReporter): Promise<Kit[]> {
  const kits = await scanDirectory(dir, async bin => {
    log.trace(localize('checking.file.for.compiler.features', 'Checking file for compiler features: {0}', bin));
    try {
      return await kitIfCompiler(bin, pr);
    } catch (e) {
      log.warning(localize('filed.to.check.binary', 'Failed to check binary {0} by exception: {1}', bin, e));
      if (e.code == 'EACCES') {
        // The binary may not be executable by this user...
        return null;
      } else if (e.code == 'ENOENT') {
        // This will happen on Windows if we try to "execute" a directory
        return null;
      } else if (e.code == 'UNKNOWN' && process.platform == 'win32') {
        // This is when file is not executable (in windows)
        return null;
      }
      const stat = await fs.stat(bin);
      log.debug('File infos: ',
                'Mode',
                stat.mode,
                'isFile',
                stat.isFile(),
                'isDirectory',
                stat.isDirectory(),
                'isSymbolicLink',
                stat.isSymbolicLink());
      rollbar.exception(localize('failed.to.scan.kit', 'Failed to scan a kit file'), e, {bin, exception: e.code, stat});
      return null;
    }
  });
  log.debug(localize('founds.kits.in.directory', 'Found {0} kits in directory {1}', kits.length, dir));
  return kits;
}

/**
 * Construct the Kit.visualStudio property (legacy)
 *
 * @param inst The VSInstallation to use
 */
function legacyKitVSName(inst: VSInstallation): string {
  return `VisualStudio.${parseInt(inst.installationVersion)}.0`;
}

/**
 * Construct the Kit.visualStudio property.
 *
 * @param inst The VSInstallation to use
 */
function kitVSName(inst: VSInstallation): string {
  return `${inst.instanceId}`;
}

/**
 * Construct the Visual Studio version string.
 *
 * @param inst The VSInstallation to use
 */
export function vsVersionName(inst: VSInstallation): string {
  if (!inst.catalog) {
    return inst.instanceId;
  }
  const end = inst.catalog.productDisplayVersion.indexOf('[');
  return end < 0 ? inst.catalog.productDisplayVersion : inst.catalog.productDisplayVersion.substring(0, end - 1);
}

/**
 * Construct the display name (this will be paired with an
 * arch later to construct the Kit.name property).
 *
 * @param inst The VSInstallation to use
 */
export function vsDisplayName(inst: VSInstallation): string {
  if (inst.displayName) {
    if (inst.channelId) {
      const index = inst.channelId.lastIndexOf('.');
      if (index > 0) {
        return `${inst.displayName} ${inst.channelId.substr(index + 1)}`;
      }
    }
    return inst.displayName;
  }
  return inst.instanceId;
}

/**
 * Construct the Kit.name property.
 *
 * @param inst The VSInstallation to use
 * @param arch The desired architecture (e.g. x86, amd64)
 */
function kitName(inst: VSInstallation, arch: string): string {
  return `${vsDisplayName(inst)} - ${arch}`;
}

/**
 * List of environment variables required for Visual C++ to run as expected for
 * a VS installation.
 */
const MSVC_ENVIRONMENT_VARIABLES = [
  'CL',
  '_CL_',
  'INCLUDE',
  'LIBPATH',
  'LINK',
  '_LINK_',
  'LIB',
  'PATH',
  'TMP',
  'FRAMEWORKDIR',
  'FRAMEWORKDIR64',
  'FRAMEWORKVERSION',
  'FRAMEWORKVERSION64',
  'UCRTCONTEXTROOT',
  'UCRTVERSION',
  'UNIVERSALCRTSDKDIR',
  'VCINSTALLDIR',
  'VCTARGETSPATH',
  'WINDOWSLIBPATH',
  'WINDOWSSDKDIR',
  'WINDOWSSDKLIBVERSION',
  'WINDOWSSDKVERSION',
  'VISUALSTUDIOVERSION'
];

/**
 * Get the environment variables corresponding to a VS dev batch file.
 * @param devbat Path to a VS environment batch file
 * @param args List of arguments to pass to the batch file
 */
async function collectDevBatVars(devbat: string, args: string[], major_version: number, common_dir: string):
    Promise<Map<string, string>|undefined> {
  const fname = Math.random().toString() + '.bat';
  const batfname = `vs-cmt-${fname}`;
  const envfname = batfname + '.env';
  const bat = [
    `@echo off`,
    `cd /d "%~dp0"`,
    `set "VS${major_version}0COMNTOOLS=${common_dir}"`,
    `call "${devbat}" ${args.join(' ')} || exit`,
    `cd /d "%~dp0"`, /* Switch back to original drive */
  ];
  for (const envvar of MSVC_ENVIRONMENT_VARIABLES) {
    bat.push(`echo ${envvar} := %${envvar}% >> ${envfname}`);
  }
  const batpath = path.join(paths.tmpDir, batfname);
  const envpath = path.join(paths.tmpDir, envfname);
  try {
    await fs.unlink(envpath);
  } catch (error) {}
  await fs.writeFile(batpath, bat.join('\r\n'));
  const res = await proc.execute(batpath, [], null, {shell: true, silent: true}).result;
  await fs.unlink(batpath);
  const output = (res.stdout) ? res.stdout + (res.stderr || '') : res.stderr;

  let env = '';
  try {
    /* When the bat running failed, envpath would not exist */
    env = await fs.readFile(envpath, {encoding: 'utf8'});
    await fs.unlink(envpath);
  } catch (error) { log.error(error); }

  if (!env || env === '') {
    console.log(`Error running ${devbat} ${args.join(' ')} with:`, output);
    return;
  }

  const vars
      = env.split('\n').map(l => l.trim()).filter(l => l.length !== 0).reduce<Map<string, string>>((acc, line) => {
          const mat = /(\w+) := ?(.*)/.exec(line);
          if (mat) {
            acc.set(mat[1], mat[2]);
          } else {
            log.error(localize('error.parsing.environment', 'Error parsing environment variable: {0}', line));
          }
          return acc;
        }, new Map());
  if (vars.get('INCLUDE') === '') {
    console.log(`Error running ${devbat} ${args.join(' ')}, can not found INCLUDE`);
    return;
  }
  log.debug(localize('ok.running', 'OK running {0} {1}, env vars: {2}', devbat, args.join(' '), JSON.stringify([...vars])));
  return vars;
}

/**
 * Platform arguments for VS Generators
 */
const VsArchitectures: {[key: string]: string} = {
  amd64: 'x64',
  arm: 'ARM',
  amd64_arm: 'ARM',
};

/**
 * Preferred CMake VS generators by VS version
 */
const VsGenerators: {[key: string]: string} = {
  10: 'Visual Studio 10 2010',
  11: 'Visual Studio 11 2012',
  VS120COMNTOOLS: 'Visual Studio 12 2013',
  12: 'Visual Studio 12 2013',
  VS140COMNTOOLS: 'Visual Studio 14 2015',
  14: 'Visual Studio 14 2015',
  15: 'Visual Studio 15 2017',
  16: 'Visual Studio 16 2019'
};

async function varsForVSInstallation(inst: VSInstallation, arch: string): Promise<Map<string, string>|null> {
  console.log(`varsForVSInstallation path:'${inst.installationPath}' version:${inst.installationVersion} arch:${arch}`);
  const common_dir = path.join(inst.installationPath, 'Common7', 'Tools');
  let devbat = path.join(inst.installationPath, 'VC', 'Auxiliary', 'Build', 'vcvarsall.bat');
  const majorVersion = parseInt(inst.installationVersion);
  if (majorVersion < 15) {
    devbat = path.join(inst.installationPath, 'VC', 'vcvarsall.bat');
  }
  const variables = await collectDevBatVars(devbat, [`${arch}`], majorVersion, common_dir);
  if (!variables) {
    return null;
  } else {
    // This is a very *hacky* and sub-optimal solution, but it
    // works for now. This *helps* CMake make the right decision
    // when you have the release and pre-release edition of the same
    // VS version installed. I don't really know why or what causes
    // this issue, but this here seems to work. It basically just sets
    // the VS{vs_version_number}COMNTOOLS environment variable to contain
    // the path to the Common7 directory.
    const vs_version = variables.get('VISUALSTUDIOVERSION');
    if (vs_version)
      variables.set(`VS${vs_version.replace('.', '')}COMNTOOLS`, common_dir);

    // For Ninja and Makefile generators, CMake searches for some compilers
    // before it checks for cl.exe. We can force CMake to check cl.exe first by
    // setting the CC and CXX environment variables when we want to do a
    // configure.
    variables.set('CC', 'cl.exe');
    variables.set('CXX', 'cl.exe');

    if (null !== paths.ninjaPath) {
      let envPATH = variables.get('PATH');
      if (undefined !== envPATH) {
        const env_paths = envPATH.split(';');
        const ninja_path = path.dirname(paths.ninjaPath);
        const ninja_base_path = env_paths.find(path_el => path_el === ninja_path);
        if (undefined === ninja_base_path) {
          envPATH = envPATH.concat(';' + ninja_path);
          variables.set('PATH', envPATH);
        }
      }
    }

    return variables;
  }
}

/**
 * Try to get a VSKit from a VS installation and architecture
 * @param inst A VS installation from vswhere
 * @param arch The architecture to try
 */
async function tryCreateNewVCEnvironment(inst: VSInstallation, arch: string, pr?: ProgressReporter): Promise<Kit|null> {
  const name = kitName(inst, arch);
  log.debug(localize('checking.for.kit', 'Checking for kit: {0}', name));
  if (pr) {
    pr.report({message: localize('checking', 'Checking {0}', name)});
  }
  const variables = await varsForVSInstallation(inst, arch);
  if (!variables)
    return null;

  const kit: Kit = {
    name,
    visualStudio: kitVSName(inst),
    visualStudioArchitecture: arch,
  };

  const version = /^(\d+)+./.exec(inst.installationVersion);
  log.debug(localize('detected.kit.for.version', 'Detected VsKit for version'));
  log.debug(` DisplayName: ${name}`);
  log.debug(` InstanceId: ${inst.instanceId}`);
  log.debug(` InstallVersion: ${inst.installationVersion}`);
  if (version) {
    const generatorName: string|undefined = VsGenerators[version[1]];
    if (generatorName) {
      log.debug(` ${localize('generator.present', 'Generator Present: {0}', generatorName)}`);
      kit.preferredGenerator = {
        name: generatorName,
        platform: VsArchitectures[arch] as string || undefined,
      };
    }
    log.debug(` ${localize('selected.preferred.generator.name', 'Selected Preferred Generator Name: {0} {1}', generatorName, JSON.stringify(kit.preferredGenerator))}`);
  }

  return kit;
}

/**
 * Scans the system for Visual C++ installations using vswhere
 */
export async function scanForVSKits(pr?: ProgressReporter): Promise<Kit[]> {
  const installs = await vsInstallations();
  const prs = installs.map(async(inst): Promise<Kit[]> => {
    const ret = [] as Kit[];
    const arches = ['x86', 'amd64', 'x86_amd64', 'x86_arm', 'amd64_arm', 'amd64_x86'];
    const sub_prs = arches.map(arch => tryCreateNewVCEnvironment(inst, arch, pr));
    const maybe_kits = await Promise.all(sub_prs);
    maybe_kits.map(k => k ? ret.push(k) : null);
    return ret;
  });
  const vs_kits = await Promise.all(prs);
  return ([] as Kit[]).concat(...vs_kits);
}

async function scanDirForClangCLKits(dir: string, vsInstalls: VSInstallation[]): Promise<Kit[]> {
  const kits = await scanDirectory(dir, async(binPath): Promise<Kit[]|null> => {
    if (!path.basename(binPath).startsWith('clang-cl')) {
      return null;
    }
    const version = await getClangVersion(binPath);
    if (version === null) {
      return null;
    }
    return vsInstalls.map((vs): Kit => {
      const installName = vsDisplayName(vs);
      const vs_arch = (version.target && version.target.includes('i686-pc')) ? 'x86' : 'amd64';
      return {
        name: localize('clang.for.msvc', 'Clang {0} for MSVC with {1} ({2})', version.version, installName, vs_arch),
        visualStudio: kitVSName(vs),
        visualStudioArchitecture: vs_arch,
        compilers: {
          C: binPath,
          CXX: binPath,
        },
      };
    });
  });
  return ([] as Kit[]).concat(...kits);
}

export async function scanForClangCLKits(searchPaths: string[]): Promise<Promise<Kit[]>[]> {
  const vs_installs = await vsInstallations();
  const results = searchPaths.map(p => scanDirForClangCLKits(p, vs_installs));
  return results;
}

async function getVSInstallForKit(kit: Kit): Promise<VSInstallation|undefined> {
    if (process.platform !== "win32") {
        return undefined;
    }

    console.assert(kit.visualStudio);
    console.assert(kit.visualStudioArchitecture);

    const installs = await vsInstallations();
    const match = (inst: VSInstallation) =>
        // old Kit format
        (legacyKitVSName(inst) == kit.visualStudio) ||
        // new Kit format
        (kitVSName(inst) === kit.visualStudio) ||
        // Clang for VS kit format
        (!!kit.compilers && kit.name.indexOf("Clang") >= 0 && kit.name.indexOf(vsDisplayName(inst)) >= 0);

    return installs.find(inst => match(inst));
}

export async function getVSKitEnvironment(kit: Kit): Promise<Map<string, string>|null> {
  const requested = await getVSInstallForKit(kit);
  if (!requested) {
    return null;
  }
  return varsForVSInstallation(requested, kit.visualStudioArchitecture!);
}

export async function effectiveKitEnvironment(kit: Kit, opts?: expand.ExpansionOptions): Promise<Map<string, string>> {
  const host_env = objectPairs(process.env) as [string, string][];
  const kit_env = objectPairs(kit.environmentVariables || {});
  if (opts) {
    for (const env_var of kit_env) {
      env_var[1] = await expand.expandString(env_var[1], opts);
    }
  }
  if (kit.visualStudio && kit.visualStudioArchitecture) {
    const vs_vars = await getVSKitEnvironment(kit);
    if (vs_vars) {
      return new Map(
          util.map(util.chain(host_env, kit_env, vs_vars), ([k, v]): [string, string] => [k.toLocaleUpperCase(), v]));
    }
  }
  const env = new Map(util.chain(host_env, kit_env));
  if (env.has("CMT_MINGW_PATH")) {
    if (env.has("PATH")) {
      env.set("PATH", env.get("PATH")!.concat(`;${env.get("CMT_MINGW_PATH")}`));
    } else if (env.has("Path")) {
      env.set("Path", env.get("Path")!.concat(`;${env.get("CMT_MINGW_PATH")}`));
    }
  }
  return env;
}

export async function findCLCompilerPath(env: Map<string, string>): Promise<string|null> {
  const path_var = util.find(env.entries(), ([key, _val]) => key.toLocaleLowerCase() === 'path');
  if (!path_var) {
    return null;
  }
  const path_ext_var = util.find(env.entries(), ([key, _val]) => key.toLocaleLowerCase() === 'pathext');
  if (!path_ext_var) {
    return null;
  }
  const path_val = path_var[1];
  const path_ext = path_ext_var[1];
  for (const dir of path_val.split(';')) {
    for (const ext of path_ext.split(';')) {
      const fname = `cl${ext}`;
      const testpath = path.join(dir, fname);
      const stat = await fs.tryStat(testpath);
      if (stat && !stat.isDirectory()) {
        return testpath;
      }
    }
  }
  return null;
}

export interface KitScanOptions {
  scanDirs?: string[];
  minGWSearchDirs?: string[];
}

/**
 * Search for Kits available on the platform.
 * @returns A list of Kits.
 */
export async function scanForKits(opt?: KitScanOptions) {
  const kit_options = opt || {};

  log.debug(localize('scanning.for.kits.on.system', 'Scanning for Kits on system'));
  const prog = {
    location: vscode.ProgressLocation.Notification,
    title: localize('scanning.for.kits', 'Scanning for kits'),
  };

  return vscode.window.withProgress(prog, async pr => {
    const isWin32 = (process.platform === 'win32');

    pr.report({message: localize('scanning.for.cmake.kits', 'Scanning for CMake kits...')});
    const scan_paths = new Set<string>();

    // Search directories on `PATH` for compiler binaries
    if (process.env.hasOwnProperty('PATH')) {
      const sep = isWin32 ? ';' : ':';
      for (const dir of (process.env.PATH as string).split(sep)) {
        scan_paths.add(dir);
      }
    }

    // Search them all in parallel
    let kit_promises = [] as Promise<Kit[]>[];
    if (isWin32 && kit_options.minGWSearchDirs) {
      for (const dir of convertMingwDirsToSearchPaths(kit_options.minGWSearchDirs)) {
        scan_paths.add(dir);
      }
    }
    const compiler_kits = Array.from(scan_paths).map(path_el => scanDirForCompilerKits(path_el, pr));
    kit_promises = kit_promises.concat(compiler_kits);
    if (isWin32) {
      // Prepare clang-cl search paths
      const clang_cl_paths = new Set<string>();

      // LLVM_ROOT environment variable location
      if (process.env.hasOwnProperty('LLVM_ROOT')) {
        const llvm_root = path.normalize(process.env.LLVM_ROOT as string + "\\bin");
        clang_cl_paths.add(llvm_root);
      }
      // Default installation locations
      clang_cl_paths.add(paths.windows.ProgramFiles + '\\LLVM\\bin');
      clang_cl_paths.add(paths.windows.ProgramFilesX86 + '\\LLVM\\bin');
      // PATH environment variable locations
      scan_paths.forEach(path_el => clang_cl_paths.add(path_el));
      // LLVM bundled in VS locations
      const vs_installs = await vsInstallations();
      const bundled_clang_cl_paths = vs_installs.map(vs_install => {
        return vs_install.installationPath + "\\VC\\Tools\\Llvm\\bin";
      });
      bundled_clang_cl_paths.forEach(path_ => {clang_cl_paths.add(path_);});

      // Scan for kits
      const vs_kits = scanForVSKits(pr);
      kit_promises.push(vs_kits);
      const cl_paths = Array.from(clang_cl_paths);
      const clang_cl_kits = await scanForClangCLKits(cl_paths);
      kit_promises = kit_promises.concat(clang_cl_kits);
    }

    const arrays = await Promise.all(kit_promises);
    const kits = ([] as Kit[]).concat(...arrays);
    kits.map(k => log.info(localize('found.kit', 'Found Kit: {0}', k.name)));

    return kits;
  });
}

/**
 * Generates a string description of a kit. This is shown to the user.
 * @param kit The kit to generate a description for
 */
export async function descriptionForKit(kit: Kit): Promise<string> {
  if (kit.toolchainFile) {
    return localize('kit.for.toolchain.file', 'Kit for toolchain file {0}', kit.toolchainFile);
  }
  if (kit.visualStudio) {
    const inst = await getVSInstallForKit(kit);
    if (inst) {
      return localize('using.compilers.for', 'Using compilers for {0} ({1} architecture)', vsVersionName(inst), kit.visualStudioArchitecture);
    }
    return '';
  }
  if (kit.compilers) {
    const compilers = Object.keys(kit.compilers).map(k => `${k} = ${kit.compilers![k]}`);
    return localize('using.compilers', 'Using compilers: {0}', compilers.join(', '));
  }
  if (kit.name === SpecialKits.ScanForKits) {
    return localize('search.for.compilers', 'Search for compilers on this computer');
  }
  return localize('unspecified.let.cmake.guess', 'Unspecified (Let CMake guess what compilers and environment to use)');
}

export async function readKitsFile(filepath: string): Promise<Kit[]> {
  if (!await fs.exists(filepath)) {
    log.debug(localize('not.reading.nonexistent.kit', 'Not reading non-existent kits file: {0}', filepath));
    return [];
  }
  log.debug(localize('reading.kits.file', 'Reading kits file {0}', filepath));
  const content_str = await fs.readFile(filepath);
  let kits_raw: object[] = [];
  try {
    kits_raw = json5.parse(content_str.toLocaleString());
  } catch (e) {
    log.error(localize('failed.to.parse', 'Failed to parse {0}: {1}', "cmake-kits.json", e));
    return [];
  }
  const validator = await loadSchema('schemas/kits-schema.json');
  const is_valid = validator(kits_raw);
  if (!is_valid) {
    const errors = validator.errors!;
    log.error(localize('invalid.file.error', 'Invalid {0} ({1}):', "cmake-kits.json", filepath));
    for (const err of errors) {
      log.error(` >> ${err.dataPath}: ${err.message}`);
    }
    return [];
  }
  const kits = kits_raw as Kit[];
  log.info(localize('successfully.loaded.kits', 'Successfully loaded {0} kits from {1}', kits.length, filepath));
  return dropNulls(kits);
}

function convertMingwDirsToSearchPaths(mingwDirs: string[]): string[] {
  return mingwDirs.map(mingwDir => path.join(mingwDir, 'bin'));
}

/**
 * Get the path to a workspace-specific cmake-kits.json for a given worksapce directory
 * @param dirPath The directory of a workspace
 */
export function kitsPathForWorkspaceDirectoryPath(dirPath: string): string {
  return path.join(dirPath, '.vscode/cmake-kits.json');
}

/**
 * Get the path to the workspace-specific cmake-kits.json for a given WorkspaceFolder object
 * @param ws The workspace folder
 */
export function kitsPathForWorkspaceFolder(ws: vscode.WorkspaceFolder): string {
  return kitsPathForWorkspaceDirectoryPath(ws.uri.fsPath);
}

/**
 * Get the kits declared for the given workspace directory. Looks in `.vscode/cmake-kits.json`.
 * @param dirPath The path to a VSCode workspace directory
 */
export function kitsForWorkspaceDirectory(dirPath: string): Promise<Kit[]> {
  const ws_kits_file = path.join(dirPath, '.vscode/cmake-kits.json');
  return readKitsFile(ws_kits_file);
}

export function kitChangeNeedsClean(newKit: Kit, oldKit: Kit|null): boolean {
  if (!oldKit) {
    // First kit? We never clean
    log.debug(localize('clean.not.needed', 'Clean not needed: No prior Kit selected'));
    return false;
  }
  const important_params = (k: Kit) => ({
    compilers: k.compilers,
    vs: k.visualStudio,
    vsArch: k.visualStudioArchitecture,
    tc: k.toolchainFile,
    preferredGenerator: k.preferredGenerator ? k.preferredGenerator.name : null
  });
  const new_imp = important_params(newKit);
  const old_imp = important_params(oldKit);
  if (compare(new_imp, old_imp) != Ordering.Equivalent) {
    log.debug(localize('clean.needed', 'Need clean: Kit changed'));
    return true;
  } else {
    return false;
  }
}

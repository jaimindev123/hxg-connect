/**
 * Expo config plugin: sign Android release builds (bundleRelease / assembleRelease)
 * with an upload keystore instead of the debug keystore.
 *
 * Credentials are NOT baked into android/. The generated build.gradle reads them at
 * build time from a gitignored properties file (default:
 * credentials/android/keystore.properties, relative to the project root):
 *
 *   storeFile=release.keystore        # relative to the properties file
 *   storePassword=...
 *   keyAlias=...
 *   keyPassword=...
 *
 * If the file is missing, release falls back to the debug key and Gradle prints a warning.
 * See https://reactnative.dev/docs/signed-apk-android
 */
const { withAppBuildGradle } = require('expo/config-plugins');

const MARKER = '// @hxg/release-signing';
const DEFAULT_PROPERTIES_PATH = 'credentials/android/keystore.properties';

function addPropertiesLoader(gradle, propertiesPath) {
  if (gradle.includes(`${MARKER}: loader`)) return gradle;
  const loader = `${MARKER}: loader
def releaseKeystorePropsFile = new File(rootProject.projectDir.parentFile, "${propertiesPath}")
def releaseKeystoreProps = new Properties()
if (releaseKeystorePropsFile.exists()) {
    releaseKeystorePropsFile.withInputStream { releaseKeystoreProps.load(it) }
} else {
    logger.warn("[release-signing] \${releaseKeystorePropsFile} not found - release builds will use the DEBUG keystore.")
}

`;
  const anchor = /^android\s*\{/m;
  if (!anchor.test(gradle)) throw new Error('[withAndroidReleaseSigning] Could not find `android {` in app/build.gradle');
  return gradle.replace(anchor, (m) => loader + m);
}

function addReleaseSigningConfig(gradle) {
  if (gradle.includes(`${MARKER}: signingConfig`)) return gradle;
  const releaseConfig = `
        ${MARKER}: signingConfig
        release {
            if (releaseKeystorePropsFile.exists()) {
                storeFile new File(releaseKeystorePropsFile.parentFile, releaseKeystoreProps['storeFile'])
                storePassword releaseKeystoreProps['storePassword']
                keyAlias releaseKeystoreProps['keyAlias']
                keyPassword releaseKeystoreProps['keyPassword']
            }
        }`;
  const anchor = /signingConfigs\s*\{/;
  if (!anchor.test(gradle)) throw new Error('[withAndroidReleaseSigning] Could not find `signingConfigs {` in app/build.gradle');
  return gradle.replace(anchor, (m) => m + releaseConfig);
}

function useReleaseSigningInReleaseBuildType(gradle) {
  if (gradle.includes(`${MARKER}: buildType`)) return gradle;
  // Match the `release {` block inside buildTypes and its `signingConfig signingConfigs.debug` line.
  const re = /(buildTypes\s*\{[\s\S]*?release\s*\{[\s\S]*?)signingConfig\s+signingConfigs\.debug/;
  if (!re.test(gradle)) throw new Error('[withAndroidReleaseSigning] Could not find release signingConfig in buildTypes');
  return gradle.replace(
    re,
    `$1${MARKER}: buildType\n            signingConfig releaseKeystorePropsFile.exists() ? signingConfigs.release : signingConfigs.debug`
  );
}

module.exports = function withAndroidReleaseSigning(config, props = {}) {
  const propertiesPath = props.propertiesPath || DEFAULT_PROPERTIES_PATH;
  return withAppBuildGradle(config, (cfg) => {
    if (cfg.modResults.language !== 'groovy') {
      throw new Error('[withAndroidReleaseSigning] Only Groovy build.gradle is supported');
    }
    let gradle = cfg.modResults.contents;
    gradle = addPropertiesLoader(gradle, propertiesPath);
    gradle = addReleaseSigningConfig(gradle);
    gradle = useReleaseSigningInReleaseBuildType(gradle);
    cfg.modResults.contents = gradle;
    return cfg;
  });
};

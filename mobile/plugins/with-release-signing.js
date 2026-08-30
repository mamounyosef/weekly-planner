// Keeps release signing and ABI splits through `expo prebuild`.
//
// `prebuild` regenerates android/ from scratch. Editing build.gradle by hand
// works exactly once: the next prebuild silently reverts it, the release build
// falls back to the DEBUG key, and the resulting APK cannot update an installed
// release one — Android rejects it as a different app signature, with a message
// that says nothing about signing. So the edits live here instead.

const { withAppBuildGradle } = require('expo/config-plugins');

const SIGNING_CONFIG = `
        // Release signing. The keystore and its password live OUTSIDE this
        // repository and are read from keystore.properties, which is gitignored:
        // committing either would let anyone publish an update that Android
        // accepts as this app. Without that file the build falls back to the
        // debug key so a fresh checkout still builds, but such an APK cannot
        // update an installed release one.
        release {
            def props = new Properties()
            // ONE LEVEL UP, outside android/: prebuild --clean deletes
            // that whole folder, which silently took the credentials with it and
            // produced a debug-signed "release" build that Android then refused
            // to install over the real one.
            def propsFile = rootProject.file('../keystore.properties')
            if (propsFile.exists()) {
                propsFile.withInputStream { props.load(it) }
                storeFile file(props['storeFile'])
                storePassword props['storePassword']
                keyAlias props['keyAlias']
                keyPassword props['keyPassword']
            } else {
                storeFile file('debug.keystore')
                storePassword 'android'
                keyAlias 'androiddebugkey'
                keyPassword 'android'
            }
        }`;

const SPLITS = `
    // One universal APK carries native code for every CPU and weighs ~79 MB.
    // Splitting produces a ~32 MB APK per architecture. The universal build is
    // still produced as a fallback: installing the wrong architecture fails with
    // an unhelpful "app not installed", and guessing wrong is not worth 45 MB.
    splits {
        abi {
            enable true
            reset()
            include 'arm64-v8a', 'armeabi-v7a'
            universalApk true
        }
    }
`;

function addSigningConfig(contents) {
  if (contents.includes('propsFile.withInputStream')) return contents;

  // Insert the release config as a sibling of the generated debug one.
  const marker = /signingConfigs\s*\{\s*debug\s*\{[\s\S]*?\}\s*\n(\s*)\}/;
  const match = marker.exec(contents);
  if (!match) {
    throw new Error('with-release-signing: could not find signingConfigs { debug { ... } }');
  }
  const insertAt = match.index + match[0].lastIndexOf('}');
  return contents.slice(0, insertAt) + SIGNING_CONFIG + '\n' + match[1] + contents.slice(insertAt);
}

function useReleaseSigningConfig(contents) {
  // The template points the release build type at the DEBUG signing config.
  return contents.replace(
    /(release\s*\{[^}]*?)signingConfig\s+signingConfigs\.debug/,
    '$1signingConfig signingConfigs.release',
  );
}

function addSplits(contents) {
  if (contents.includes("include 'arm64-v8a', 'armeabi-v7a'")) return contents;
  const anchor = '    packagingOptions {';
  if (!contents.includes(anchor)) {
    throw new Error('with-release-signing: could not find packagingOptions to anchor splits');
  }
  return contents.replace(anchor, SPLITS + anchor);
}

module.exports = function withReleaseSigning(config) {
  return withAppBuildGradle(config, mod => {
    if (mod.modResults.language !== 'groovy') {
      throw new Error('with-release-signing: expected a Groovy build.gradle');
    }
    let contents = mod.modResults.contents;
    contents = addSigningConfig(contents);
    contents = useReleaseSigningConfig(contents);
    contents = addSplits(contents);
    mod.modResults.contents = contents;
    return mod;
  });
};

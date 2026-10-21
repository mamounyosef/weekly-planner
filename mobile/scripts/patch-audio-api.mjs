// Two fixes to react-native-audio-api 0.13.6 for voice mode. Idempotent; runs
// on postinstall and from scripts/build-apk.ps1.
//
// 1. Echo cancellation. Voice mode plays the assistant's voice through the
// speaker while the mic listens for you to talk over it. The library opens the
// mic with Oboe's default "voice recognition" preset, which has no echo
// cancellation, so the assistant would hear itself. The "voice communication"
// preset is what calls use: the platform cancels the phone's own output from
// the mic. That preset needs a shared stream, not an exclusive one. (Later
// versions of the library expose this as `androidInputPreset`.)
//
// 2. Windows path length. The library compiles C++ that lives outside its
// CMake folder, and CMake names those object folders after their full
// absolute path, under "D:\My Projects\weekly-planner\mobile\...\.cxx\...".
// That passed ninja's 260-character limit and the build stopped. So its C++
// build folder moves to a short one at the drive root, D:\rnaa (a build cache
// only, safe to delete; %TEMP% was still too long for its deepest folders),
// and CMake is told to hash object file names that would still be long. (A
// drive letter made with `subst` does not work: Node resolves it back to D:.)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const lib = path.join(here, '..', 'node_modules', 'react-native-audio-api', 'android');
const recorderFile = path.join(lib, 'src', 'main', 'cpp', 'audioapi', 'android', 'core', 'AndroidAudioRecorder.cpp');
const gradleFile = path.join(lib, 'build.gradle');

const PATCHES = [
  {
    file: recorderFile,
    what: 'echo cancellation (voice communication preset)',
    mark: 'InputPreset::VoiceCommunication',
    from: 'builder.setSharingMode(oboe::SharingMode::Exclusive)\n      ->setDirection(oboe::Direction::Input)',
    to: 'builder.setSharingMode(oboe::SharingMode::Shared)\n      ->setDirection(oboe::Direction::Input)\n      ->setInputPreset(oboe::InputPreset::VoiceCommunication)',
  },
  {
    file: gradleFile,
    what: 'hashed object file names (Windows path length)',
    mark: 'CMAKE_OBJECT_PATH_MAX',
    from: '"-DANDROID_STL=c++_shared",',
    to: '"-DANDROID_STL=c++_shared",\n          "-DCMAKE_OBJECT_PATH_MAX=128",',
  },
  {
    file: gradleFile,
    what: 'short C++ build folder (Windows path length)',
    mark: 'buildStagingDirectory',
    from: '  externalNativeBuild {\n    cmake {\n      path "CMakeLists.txt"\n    }\n  }',
    to: '  externalNativeBuild {\n    cmake {\n      path "CMakeLists.txt"\n      buildStagingDirectory file("${rootDir.toPath().getRoot()}rnaa")\n    }\n  }',
  },
];

if (!fs.existsSync(gradleFile)) {
  console.log('patch-audio-api: library not installed, nothing to do');
  process.exit(0);
}

for (const p of PATCHES) {
  const src = fs.readFileSync(p.file, 'utf-8').replace(/\r\n/g, '\n');
  if (src.includes(p.mark)) {
    console.log(`patch-audio-api: ${p.what}: already on`);
  } else if (!src.includes(p.from)) {
    console.error(`patch-audio-api: ${path.basename(p.file)} changed; ${p.what} NOT applied. Update this script.`);
    process.exit(1);
  } else {
    fs.writeFileSync(p.file, src.replace(p.from, p.to));
    console.log(`patch-audio-api: ${p.what}: applied`);
  }
}

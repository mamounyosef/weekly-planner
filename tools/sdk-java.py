"""Run sdkmanager / avdmanager straight through java.

Something on this PC deletes .bat files inside the Android SDK tree (including
sdkmanager.bat and avdmanager.bat), so the launchers cannot be trusted. The
jars they wrap are untouched, so this calls them directly.

Usage:
  python tools/sdk-java.py sdkmanager --list_installed
  python tools/sdk-java.py sdkmanager "system-images;android-35;google_apis;x86_64" emulator
  python tools/sdk-java.py avdmanager list avd
"""
import glob
import os
import subprocess
import sys

DEV = r"C:\Users\mamou\dev-tools"
SDK = os.path.join(DEV, "android-sdk")
TOOLS = os.path.join(DEV, "cmdline-runner", "cmdline-tools")
JAVA = glob.glob(os.path.join(DEV, "jdk", "*", "bin", "java.exe"))[0]

MAIN = {
    "sdkmanager": ("sdkmanager-classpath.jar", "com.android.sdklib.tool.sdkmanager.SdkManagerCli"),
    "avdmanager": ("avdmanager-classpath.jar", "com.android.sdklib.tool.AvdManagerCli"),
}


def main() -> int:
    if len(sys.argv) < 2 or sys.argv[1] not in MAIN:
        print(__doc__)
        return 2
    jar, cls = MAIN[sys.argv[1]]
    args = sys.argv[2:]
    if sys.argv[1] == "sdkmanager" and not any(a.startswith("--sdk_root") for a in args):
        args = [f"--sdk_root={SDK}"] + args
    env = dict(os.environ, ANDROID_HOME=SDK, ANDROID_SDK_ROOT=SDK)
    cmd = [JAVA, f"-Dcom.android.sdkmanager.toolsdir={TOOLS}",
           "-classpath", os.path.join(TOOLS, "lib", jar), cls] + args
    # "y" answers licence prompts for packages from Google's own repository.
    return subprocess.run(cmd, env=env, input="y\n" * 20, text=True).returncode


if __name__ == "__main__":
    sys.exit(main())

# Agency Calculator — Android sample built by an agency agent

This is what "build an android calculator using agency agent" looks like
shipped as a sample: a **real, buildable Android calculator APK** whose
project doubles as a demonstration of the Agency Agents loop — the app was
authored under the **Mobile App Builder** agent persona
(`engineering/engineering-mobile-app-builder.md`, *"Ships native-quality
apps on iOS and Android, fast"*), and that agent file ships inside the
project as `agents/` workspace context.

- **One Java file** (`MainActivity.java`), **zero external dependencies**
  (no Kotlin, no AndroidX) — the build needs only the Android SDK + AGP
- **Exact math on BigDecimal** — `0.1 + 0.2 = 0.3`, never `0.30000000000000004`
- **Real expression engine**: tokenizer → shunting-yard → RPN with
  precedence (× ÷ before + −), unary minus, and postfix `%`
- **Live preview**: the running total updates under the expression as you type
- `⌫` backspace, `C` clear, `±` sign toggle, chaining after `=`
- **Divide by zero → "Can't divide by 0"**, malformed input → "Error"
- **Dark theme** matching Agency Agents (`#1e1e28` / indigo `#4f46e5`)
- **Zero permissions** — the manifest requests nothing; fully offline

## Layout

    settings.gradle / build.gradle / gradle.properties   standard AGP 8 project
    app/build.gradle                                     compileSdk 34, minSdk 24, no deps
    app/src/main/.../MainActivity.java                   the whole app (one file)
    app/src/main/res/values/styles.xml                   dark Material theme
    app/src/main/res/mipmap-*/ic_launcher.png            densities from the app icon
    agents/engineering-mobile-app-builder.md             the agent, installed as context

## Build (on the phone)

**If you already build APKs with DevForge** (gradle is set up —
`~/.station/gradle-profile.json`): open a session workspace on this
folder and ask the Agent to build it, or from Termux:

```bash
cd samples/android-calculator
gradle assembleDebug
termux-open app/build/outputs/apk/debug/app-debug.apk   # sideload
```

**One-time Termux setup** (~10 min, ~1.5 GB — needed for both samples):

```bash
# 1. Toolchain: Java 17, Gradle, and Termux's native aapt2
#    (Google's aapt2 binary is x86_64-only; ARM64 phones need Termux's)
pkg update
pkg install -y openjdk-17 gradle aapt2 wget unzip

# 2. Android SDK (commandline-tools are Java — they run fine on ARM64)
cd ~
wget https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip
unzip commandlinetools-linux-11076708_latest.zip
mkdir -p ~/android-sdk/cmdline-tools
mv cmdline-tools ~/android-sdk/cmdline-tools/latest

# 3. Make the env stick for future sessions
cat >> ~/.bashrc << 'EOF'
export JAVA_HOME=/data/data/com.termux/files/usr/opt/openjdk
export ANDROID_HOME=$HOME/android-sdk
export PATH=$PATH:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools
EOF
source ~/.bashrc

# 4. SDK platform + build tools (accept licenses with yes)
yes | sdkmanager --licenses
sdkmanager "platforms;android-34" "build-tools;34.0.0"
```

The project's `gradle.properties` already points `android.aapt2FromMavenOverride`
at Termux's aapt2, so the build uses the ARM64 binary. Then:

```bash
cd <this folder>
gradle assembleDebug
```

If Termux's `gradle` is older than 8.7 (AGP 8.5.2 needs ≥ 8.7 — check
`gradle --version`), bootstrap the pinned wrapper instead:

```bash
gradle wrapper --gradle-version 8.7
./gradlew assembleDebug
```

## The full sample loop (why this project exists)

1. **Pull this branch** on the phone
2. **Projects view** → Add → pick `samples/android-calculator`
3. The **Mobile App Builder agent** is already installed in the project
   (`agents/engineering-mobile-app-builder.md`) — chat with it and it
   sees this workspace
4. **Build the APK** with gradle (above) — your agency-built calculator
   on the home screen
5. **Extend it by chatting**: the calculator deliberately has **no
   parentheses** — ask the Mobile App Builder to add `( )` keys and
   grouping support, then rebuild. That chat → edit → rebuild cycle is
   the whole point of the sample.

## Notes

- `%` is postfix "divide this operand by 100" (`50%` → `0.5`,
  `200+10%` → `200.1`).
- Debug-signed (personal sideload). For a release keystore see the
  `samples/android-launcher` README.
- The gradle wrapper properties point at Gradle 8.7; the wrapper JAR is
  intentionally not committed — use your installed `gradle` (or
  `gradle wrapper` once to generate it).

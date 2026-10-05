# Agency Agents — Android launcher (sample project)

A real, buildable Android app: a native shell around the Agency Agents
web app served by Termux at `http://localhost:8787`. One Activity, one
WebView, **zero external dependencies** (no Kotlin, no AndroidX) — the
build needs only the Android SDK + Android Gradle Plugin.

What you get as an APK:

- A real **Agency Agents icon** on your home screen (beyond the PWA)
- Full-screen web app with **JS + localStorage on** (chat history persists)
- Cleartext HTTP allowed **only** to `localhost`/`127.0.0.1` (network
  security config; everything else keeps Android's secure defaults)
- Dark offline screen with a **Retry** button when the Termux server is down
- Back button walks WebView history

## Layout

    settings.gradle / build.gradle / gradle.properties   standard AGP 8 project
    app/build.gradle                                     compileSdk 34, minSdk 24, no deps
    app/src/main/.../MainActivity.java                   the whole app (one file)
    app/src/main/res/xml/network_security_config.xml     localhost-only cleartext
    app/src/main/res/mipmap-*/ic_launcher.png            densities from the app icon

## Build (on the phone)

**If you already build APKs with DevForge** (gradle is set up —
`~/.station/gradle-profile.json`): open a session workspace on this
folder and ask the Agent to build it, or from Termux:

```bash
cd samples/android-launcher
gradle assembleDebug
```

APK lands at `app/build/outputs/apk/debug/app-debug.apk`. Install:

```bash
termux-open app/build/outputs/apk/debug/app-debug.apk   # sideload (allow unknown sources)
```

**One-time SDK setup if you've never built an APK on Termux:**
follow the full recipe in `samples/android-calculator/README.md`
(Java 17 + gradle + Termux `aapt2` + SDK platform 34 — needed for both
samples; this project's `gradle.properties` already carries the aapt2
override).

(DevForge's artifact/APK builder can do the heavy lifting too — point a
station build at this folder.)

## The full sample loop (why this project exists)

1. **Pull this branch** on the phone
2. **Projects view** → Add → pick `samples/android-launcher` → the project
   appears in Agency Agents
3. **Install an agent into it** (DevForge target or any project-scoped
   tool) — e.g. an engineering/mobile agent lands in `agents/*.md` as
   aider context
4. **Chat** with that agent to extend the sample (it can see the workspace)
5. **Build the APK** with gradle or DevForge, install, launch — your
   agents' app on your home screen

## Notes

- Debug-signed (personal sideload). For a release keystore:
  `keytool -genkey -v -keystore aa.jks -keyalg RSA -keysize 2048 -validity 10000 -alias aa`
  then wire `signingConfigs.release` in `app/build.gradle`.
- The gradle wrapper properties point at Gradle 8.7; the wrapper JAR is
  intentionally not committed — use your installed `gradle` (or
  `gradle wrapper` once to generate it).

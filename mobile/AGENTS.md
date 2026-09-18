# Expo HAS CHANGED

Read the exact versioned docs at https://docs.expo.dev/versions/v57.0.0/ before writing any code.

# ALWAYS PUBLISH OTA AFTER MOBILE CHANGES (standing user instruction)

Whenever any change is made to this `mobile/` app — every session, every time,
without asking — finish by publishing it over the air:

    cd mobile && npm run publish

The script typechecks, exports the JS bundle, and drops it in
`database/ota/<runtimeVersion>/<stamp>`; the phone picks it up on its next
launch (Settings → Check for update forces it immediately). Report the stamp
folder it printed so the user can verify it on the phone.

OTA CANNOT SHIP native changes. If `app.json` `plugins`/`android` changed, a
native module was added, or the Expo SDK was upgraded, say so plainly: the
runtimeVersion must be bumped and a new APK built and installed by hand — tell
the user that step is theirs. JS-only changes are always publishable.

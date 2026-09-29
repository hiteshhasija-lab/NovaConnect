# MediaPipe (background blur)

Served to browsers for background blur in calls and meetings (`public/js/background-effects.js`).
Everything runs in the user's own browser; no video leaves the device.

- `vision_bundle.mjs`, `wasm/vision_wasm_internal.{js,wasm}` — `@mediapipe/tasks-vision` 1.0.1
  (Apache-2.0, npm). Only the SIMD WebAssembly build is kept (supported by every current browser);
  a browser without WebAssembly SIMD shows blur as unavailable.
- `selfie_segmenter.tflite` — MediaPipe selfie segmenter, float16 (Apache-2.0), from
  storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/,
  249,537 bytes, SHA-256 191ac9529ae506ee0beefa6b2c945a172dab9d07d1e802a290a4e4038226658b.

To update: install the new `@mediapipe/tasks-vision` and copy the same three files over.

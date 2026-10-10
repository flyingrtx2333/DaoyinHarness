// Published system reference media, independently verified against actual MP4 files.
// Deployment installs these content-addressed blobs; no live Yinghuo dependency.
export const CAMPFIRE_REFERENCE_PRESETS = [
  {
    "key": "preset_luosifen-opening_v1",
    "title": "螺蛳粉小火锅 · 新店开业",
    "digest": "sha256:7f0f746fb157c54ef02f36763cdbdaa1f107b78bbab6e6226be86bef49134468",
    "size": 16065792,
    "durationSeconds": 37.433333,
    "width": 1080,
    "height": 1920
  },
  {
    "key": "preset_new-store-opening_v1",
    "title": "新店开业",
    "digest": "sha256:69f974b4c5504128cf604e563416afb5e18f0c7c86ec57f7cec61237828b26b5",
    "size": 25190653,
    "durationSeconds": 57.816009,
    "width": 1080,
    "height": 1920
  },
  {
    "key": "preset_buffet-value_v1",
    "title": "自助烧烤 · 超值畅吃",
    "digest": "sha256:0c71470d04b335659adca97bfbb9ebfcbe5cb5062d074a88955095eeed2a19f6",
    "size": 4871345,
    "durationSeconds": 63.566667,
    "width": 720,
    "height": 1280
  }
] as const;

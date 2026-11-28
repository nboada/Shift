// swift-tools-version:5.3

import PackageDescription

let package = Package(
  name: "tauri-plugin-phone",
  platforms: [.macOS(.v10_13), .iOS(.v13)],
  products: [
    .library(name: "tauri-plugin-phone", type: .static, targets: ["tauri-plugin-phone"])
  ],
  dependencies: [
    .package(name: "Tauri", path: "../.tauri/tauri-api")
  ],
  targets: [
    .target(name: "tauri-plugin-phone", dependencies: [.byName(name: "Tauri")], path: "Sources")
  ]
)

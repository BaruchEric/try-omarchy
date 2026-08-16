// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "OmarchyVMHelper",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "omarchy-vm-helper", targets: ["OmarchyVMHelper"]),
    ],
    targets: [
        .executableTarget(name: "OmarchyVMHelper"),
        .testTarget(name: "OmarchyVMHelperTests", dependencies: ["OmarchyVMHelper"]),
    ],
    swiftLanguageModes: [.v5]
)

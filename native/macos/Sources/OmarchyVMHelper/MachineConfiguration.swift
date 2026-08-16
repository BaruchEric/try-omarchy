import Foundation
@preconcurrency import Virtualization

struct MachinePlan: Equatable {
    let cpuCount: Int
    let memoryBytes: UInt64
    let width: Int
    let height: Int

    static func make(spec: GuestBuildSpec, hostProcessors: Int = ProcessInfo.processInfo.processorCount) throws -> MachinePlan {
        guard HostCapabilities.architecture == "arm64", HostCapabilities.virtualizationAvailable else {
            throw HelperError.unsupportedHost("ARM64 Apple virtualization is unavailable")
        }
        let requestedCPU = max(spec.runtime.minimumCpuCount ?? 4, min(8, hostProcessors - 2))
        let cpuCount = min(
            VZVirtualMachineConfiguration.maximumAllowedCPUCount,
            max(VZVirtualMachineConfiguration.minimumAllowedCPUCount, requestedCPU)
        )
        let requestedMemory = UInt64(spec.runtime.recommendedMemoryMiB) * 1024 * 1024
        let memoryBytes = min(
            VZVirtualMachineConfiguration.maximumAllowedMemorySize,
            max(VZVirtualMachineConfiguration.minimumAllowedMemorySize, requestedMemory)
        )
        return MachinePlan(
            cpuCount: cpuCount,
            memoryBytes: memoryBytes,
            width: spec.guest.virtualDisplay.width,
            height: spec.guest.virtualDisplay.height
        )
    }
}

enum MachineConfiguration {
    static func make(
        bundle: GuestBundle,
        diskURL: URL,
        plan: MachinePlan,
        machineIdentifier: VZGenericMachineIdentifier,
        serialOutput: FileHandle
    ) throws -> VZVirtualMachineConfiguration {
        let configuration = VZVirtualMachineConfiguration()
        configuration.cpuCount = plan.cpuCount
        configuration.memorySize = plan.memoryBytes
        let platform = VZGenericPlatformConfiguration()
        platform.machineIdentifier = machineIdentifier
        configuration.platform = platform

        let bootLoader = VZLinuxBootLoader(kernelURL: bundle.kernelURL)
        bootLoader.initialRamdiskURL = bundle.initramfsURL
        bootLoader.commandLine = bundle.spec.runtime.kernelCommandLine
        configuration.bootLoader = bootLoader

        let diskAttachment = try VZDiskImageStorageDeviceAttachment(
            url: diskURL,
            readOnly: false,
            cachingMode: .cached,
            synchronizationMode: .fsync
        )
        let disk = VZVirtioBlockDeviceConfiguration(attachment: diskAttachment)
        disk.blockDeviceIdentifier = "omarchy-root"
        configuration.storageDevices = [disk]

        let graphics = VZVirtioGraphicsDeviceConfiguration()
        graphics.scanouts = [
            VZVirtioGraphicsScanoutConfiguration(
                widthInPixels: plan.width,
                heightInPixels: plan.height
            ),
        ]
        configuration.graphicsDevices = [graphics]
        configuration.keyboards = [VZUSBKeyboardConfiguration()]
        configuration.pointingDevices = [VZUSBScreenCoordinatePointingDeviceConfiguration()]
        configuration.entropyDevices = [VZVirtioEntropyDeviceConfiguration()]
        configuration.memoryBalloonDevices = [VZVirtioTraditionalMemoryBalloonDeviceConfiguration()]

        let serial = VZVirtioConsoleDeviceSerialPortConfiguration()
        serial.attachment = VZFileHandleSerialPortAttachment(
            fileHandleForReading: FileHandle.standardInput,
            fileHandleForWriting: serialOutput
        )
        configuration.serialPorts = [serial]

        try configuration.validate()
        try configuration.validateSaveRestoreSupport()
        return configuration
    }
}

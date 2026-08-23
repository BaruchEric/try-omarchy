import CoreGraphics

struct NativeDisplayPolicy: Equatable {
    static let preferredMaximumWidth: CGFloat = 1_400
    static let visibleWidthFraction: CGFloat = 0.92
    static let visibleHeightFraction: CGFloat = 0.84
    static let minimumContentWidth: CGFloat = 800

    let initialContentSize: CGSize
    let minimumContentSize: CGSize
    let automaticallyReconfiguresDisplay: Bool

    static func make(
        framebufferWidth: Int,
        framebufferHeight: Int,
        streamWindow: Bool,
        visibleFrame: CGRect?
    ) -> NativeDisplayPolicy {
        let framebufferSize = CGSize(width: framebufferWidth, height: framebufferHeight)
        guard !streamWindow else {
            return NativeDisplayPolicy(
                initialContentSize: framebufferSize,
                minimumContentSize: framebufferSize,
                automaticallyReconfiguresDisplay: false
            )
        }

        let aspectRatio = CGFloat(framebufferWidth) / CGFloat(framebufferHeight)
        let available = visibleFrame?.size ?? CGSize(width: 1_440, height: 900)
        let maximumWidth = min(preferredMaximumWidth, available.width * visibleWidthFraction)
        let maximumHeight = available.height * visibleHeightFraction
        var width = maximumWidth
        var height = width / aspectRatio
        if height > maximumHeight {
            height = maximumHeight
            width = height * aspectRatio
        }

        let initial = CGSize(width: floor(width), height: floor(height))
        let minimumWidth = min(minimumContentWidth, initial.width)
        let minimum = CGSize(width: minimumWidth, height: floor(minimumWidth / aspectRatio))
        return NativeDisplayPolicy(
            initialContentSize: initial,
            minimumContentSize: minimum,
            automaticallyReconfiguresDisplay: true
        )
    }
}

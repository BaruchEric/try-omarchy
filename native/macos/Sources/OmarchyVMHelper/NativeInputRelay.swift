import CoreGraphics
import Foundation

enum NativeRemoteInput: Equatable {
    case key(sequence: Int, code: String, down: Bool)
    case pointer(sequence: Int, x: Double, y: Double, buttons: Int)
    case wheel(sequence: Int, deltaX: Double, deltaY: Double)
    case releaseAll(sequence: Int)

    var sequence: Int {
        switch self {
        case .key(let sequence, _, _), .pointer(let sequence, _, _, _),
             .wheel(let sequence, _, _), .releaseAll(let sequence):
            sequence
        }
    }

    static func parse(_ value: Any) -> NativeRemoteInput? {
        guard let object = value as? [String: Any],
              let kind = object["kind"] as? String,
              let sequence = exactInteger(object["sequence"]), sequence > 0 else {
            return nil
        }
        switch kind {
        case "key":
            guard Set(object.keys) == Set(["kind", "sequence", "code", "down"]),
                  let code = object["code"] as? String,
                  NativeInputRelay.virtualKey(for: code) != nil,
                  let down = exactBoolean(object["down"]) else { return nil }
            return .key(sequence: sequence, code: code, down: down)
        case "pointer":
            guard Set(object.keys) == Set(["kind", "sequence", "x", "y", "buttons"]),
                  let x = finiteDouble(object["x"]), x >= 0, x <= 1,
                  let y = finiteDouble(object["y"]), y >= 0, y <= 1,
                  let buttons = exactInteger(object["buttons"]), buttons >= 0, buttons <= 31 else {
                return nil
            }
            return .pointer(sequence: sequence, x: x, y: y, buttons: buttons)
        case "wheel":
            guard Set(object.keys) == Set(["kind", "sequence", "deltaX", "deltaY"]),
                  let deltaX = finiteDouble(object["deltaX"]), abs(deltaX) <= 4096,
                  let deltaY = finiteDouble(object["deltaY"]), abs(deltaY) <= 4096,
                  deltaX != 0 || deltaY != 0 else { return nil }
            return .wheel(sequence: sequence, deltaX: deltaX, deltaY: deltaY)
        case "release-all":
            guard Set(object.keys) == Set(["kind", "sequence"]) else { return nil }
            return .releaseAll(sequence: sequence)
        default:
            return nil
        }
    }

    private static func exactInteger(_ value: Any?) -> Int? {
        guard let number = value as? NSNumber,
              CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
        let double = number.doubleValue
        guard double.isFinite, double.rounded() == double,
              double >= 0, double <= Double(Int.max) else { return nil }
        return Int(double)
    }

    private static func exactBoolean(_ value: Any?) -> Bool? {
        guard let number = value as? NSNumber,
              CFGetTypeID(number) == CFBooleanGetTypeID() else { return nil }
        return number.boolValue
    }

    private static func finiteDouble(_ value: Any?) -> Double? {
        guard let number = value as? NSNumber,
              CFGetTypeID(number) != CFBooleanGetTypeID(),
              number.doubleValue.isFinite else { return nil }
        return number.doubleValue
    }
}

final class NativeInputRelay: @unchecked Sendable {
    typealias PostEvent = (CGEvent, pid_t) -> Void
    typealias WindowBounds = (pid_t) -> CGRect?

    private let postEvent: PostEvent
    private let windowBounds: WindowBounds
    private var pressedKeys = Set<CGKeyCode>()
    private var buttons = 0
    private var lastPoint: CGPoint?

    init(
        postEvent: @escaping PostEvent = { event, processIdentifier in
            event.postToPid(processIdentifier)
        },
        windowBounds: @escaping WindowBounds = NativeInputRelay.frontWindowBounds
    ) {
        self.postEvent = postEvent
        self.windowBounds = windowBounds
    }

    func send(_ input: NativeRemoteInput, to processIdentifier: pid_t) -> Bool {
        switch input {
        case .key(_, let code, let down):
            guard let key = Self.virtualKey(for: code),
                  let event = CGEvent(keyboardEventSource: nil, virtualKey: key, keyDown: down) else {
                return false
            }
            postEvent(event, processIdentifier)
            if down { pressedKeys.insert(key) }
            else { pressedKeys.remove(key) }
            return true
        case .pointer(_, let x, let y, let targetButtons):
            guard let bounds = windowBounds(processIdentifier), bounds.width > 0, bounds.height > 0 else {
                return false
            }
            let point = CGPoint(
                x: bounds.minX + x * bounds.width,
                y: bounds.minY + y * bounds.height
            )
            postMove(to: point, processIdentifier: processIdentifier)
            for bit in 0..<5 where (buttons & (1 << bit)) != (targetButtons & (1 << bit)) {
                let down = (targetButtons & (1 << bit)) != 0
                guard let event = mouseButtonEvent(bit: bit, down: down, point: point) else { continue }
                postEvent(event, processIdentifier)
            }
            buttons = targetButtons
            lastPoint = point
            return true
        case .wheel(_, let deltaX, let deltaY):
            guard let event = CGEvent(
                scrollWheelEvent2Source: nil,
                units: .pixel,
                wheelCount: 2,
                wheel1: Self.clampedWheel(-deltaY),
                wheel2: Self.clampedWheel(-deltaX),
                wheel3: 0
            ) else { return false }
            postEvent(event, processIdentifier)
            return true
        case .releaseAll:
            releaseAll(to: processIdentifier)
            return true
        }
    }

    func releaseAll(to processIdentifier: pid_t) {
        for key in pressedKeys.sorted() {
            if let event = CGEvent(keyboardEventSource: nil, virtualKey: key, keyDown: false) {
                postEvent(event, processIdentifier)
            }
        }
        pressedKeys.removeAll()
        if let point = lastPoint {
            for bit in 0..<5 where (buttons & (1 << bit)) != 0 {
                if let event = mouseButtonEvent(bit: bit, down: false, point: point) {
                    postEvent(event, processIdentifier)
                }
            }
        }
        buttons = 0
    }

    private func postMove(to point: CGPoint, processIdentifier: pid_t) {
        let type: CGEventType
        let button: CGMouseButton
        if buttons & 1 != 0 {
            type = .leftMouseDragged
            button = .left
        } else if buttons & 2 != 0 {
            type = .rightMouseDragged
            button = .right
        } else if buttons & 28 != 0 {
            type = .otherMouseDragged
            button = .center
        } else {
            type = .mouseMoved
            button = .left
        }
        if let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: button) {
            postEvent(event, processIdentifier)
        }
    }

    private func mouseButtonEvent(bit: Int, down: Bool, point: CGPoint) -> CGEvent? {
        let type: CGEventType
        let button: CGMouseButton
        switch bit {
        case 0:
            type = down ? .leftMouseDown : .leftMouseUp
            button = .left
        case 1:
            type = down ? .rightMouseDown : .rightMouseUp
            button = .right
        default:
            type = down ? .otherMouseDown : .otherMouseUp
            button = CGMouseButton(rawValue: UInt32(bit)) ?? .center
        }
        return CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: button)
    }

    private static func clampedWheel(_ value: Double) -> Int32 {
        Int32(max(Double(Int32.min), min(Double(Int32.max), value.rounded())))
    }

    static func frontWindowBounds(processIdentifier: pid_t) -> CGRect? {
        guard let windows = CGWindowListCopyWindowInfo(
            [.optionOnScreenOnly, .excludeDesktopElements],
            kCGNullWindowID
        ) as? [[String: Any]] else { return nil }
        for window in windows {
            guard (window[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == processIdentifier,
                  (window[kCGWindowLayer as String] as? NSNumber)?.intValue == 0,
                  let dictionary = window[kCGWindowBounds as String] as? [String: NSNumber],
                  let x = dictionary["X"]?.doubleValue,
                  let y = dictionary["Y"]?.doubleValue,
                  let width = dictionary["Width"]?.doubleValue,
                  let height = dictionary["Height"]?.doubleValue else { continue }
            return CGRect(x: x, y: y, width: width, height: height)
        }
        return nil
    }

    static func virtualKey(for code: String) -> CGKeyCode? {
        keyMap[code]
    }

    private static let keyMap: [String: CGKeyCode] = [
        "KeyA": 0, "KeyS": 1, "KeyD": 2, "KeyF": 3, "KeyH": 4,
        "KeyG": 5, "KeyZ": 6, "KeyX": 7, "KeyC": 8, "KeyV": 9,
        "IntlHash": 10, "IntlBackslash": 10, "KeyB": 11, "KeyQ": 12,
        "KeyW": 13, "KeyE": 14, "KeyR": 15,
        "KeyY": 16, "KeyT": 17, "Digit1": 18, "Digit2": 19, "Digit3": 20,
        "Digit4": 21, "Digit6": 22, "Digit5": 23, "Equal": 24, "Digit9": 25,
        "Digit7": 26, "Minus": 27, "Digit8": 28, "Digit0": 29,
        "BracketRight": 30, "KeyO": 31, "KeyU": 32, "BracketLeft": 33,
        "KeyI": 34, "KeyP": 35, "Enter": 36, "KeyL": 37, "KeyJ": 38,
        "Quote": 39, "KeyK": 40, "Semicolon": 41, "Backslash": 42,
        "Comma": 43, "Slash": 44, "KeyN": 45, "KeyM": 46, "Period": 47,
        "Tab": 48, "Space": 49, "Backquote": 50, "Backspace": 51,
        "Escape": 53, "MetaRight": 54, "MetaLeft": 55, "ShiftLeft": 56,
        "CapsLock": 57, "AltLeft": 58, "ControlLeft": 59, "ShiftRight": 60,
        "AltRight": 61, "ControlRight": 62, "NumpadDecimal": 65,
        "NumpadMultiply": 67, "NumpadAdd": 69, "NumLock": 71,
        "NumpadDivide": 75, "NumpadEnter": 76, "NumpadSubtract": 78,
        "NumpadEqual": 81, "Numpad0": 82, "Numpad1": 83, "Numpad2": 84,
        "Numpad3": 85, "Numpad4": 86, "Numpad5": 87, "Numpad6": 88,
        "Numpad7": 89, "Numpad8": 91, "Numpad9": 92, "F5": 96,
        "F6": 97, "F7": 98, "F3": 99, "F8": 100, "F9": 101,
        "F11": 103, "F13": 105, "F16": 106, "F14": 107, "F10": 109,
        "ContextMenu": 110, "F12": 111, "F15": 113, "Insert": 114,
        "Home": 115, "PageUp": 116, "Delete": 117, "F4": 118, "End": 119,
        "F2": 120, "PageDown": 121, "F1": 122, "ArrowLeft": 123,
        "ArrowRight": 124, "ArrowDown": 125, "ArrowUp": 126,
        "F17": 64, "F18": 79, "F19": 80, "F20": 90,
    ]
}

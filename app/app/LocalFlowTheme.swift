import SwiftUI
import UIKit

/// Native mapping of packages/ui/src/tokens.scss. Semantic system fonts support Dynamic Type.
enum LocalFlowTheme {
    static let rowInset: CGFloat = 16
    static let rowPadding: CGFloat = 12
    static let minimumTarget: CGFloat = 44
    static let cornerRadius: CGFloat = 16
    static let background = adaptive(light: 0xf5f4f0, dark: 0x131a16)
    static let surface = adaptive(light: 0xffffff, dark: 0x1e2822)
    static let text = adaptive(light: 0x242c28, dark: 0xedf2eb)
    static let muted = adaptive(light: 0x626e66, dark: 0xb0bcb1)

    private static func adaptive(light: UInt32, dark: UInt32) -> Color {
        Color(uiColor: UIColor { traits in
            let value = traits.userInterfaceStyle == .dark ? dark : light
            return UIColor(red: CGFloat((value >> 16) & 255) / 255,
                           green: CGFloat((value >> 8) & 255) / 255,
                           blue: CGFloat(value & 255) / 255, alpha: 1)
        })
    }
}

enum MobileInterfaceAvailability {
    #if DEBUG || LOCALFLOW_SHARED_UI
    static let enabled = true
    #else
    static let enabled = false
    #endif
}

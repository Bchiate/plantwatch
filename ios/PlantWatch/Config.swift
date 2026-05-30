import Foundation

/// Backend configuration for the PlantWatch iOS client.
enum Config {
    static let supabaseUrl = "https://your-project-ref.supabase.co"
    static let supabaseAnonKey = "<supabase-anon-key>"

    /// Authenticated per-user report (requires sign-in).
    static let endpoint = URL(string: "\(supabaseUrl)/functions/v1/report-v2")!

    /// Auto-refresh while the app is foregrounded.
    static let autoRefreshInterval: TimeInterval = 60
}

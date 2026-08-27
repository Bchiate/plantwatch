import SwiftUI

@main
struct PlantWatchApp: App {
    var body: some Scene {
        WindowGroup { RootView() }
    }
}

/// Routes by auth + role: signed-out → login, admin → admin dashboard,
/// normal customer → their garden. The role is resolved before routing so an
/// admin never briefly sees the customer view.
private struct RootView: View {
    @StateObject private var auth = Auth.shared
    @State private var roleResolved = false

    var body: some View {
        Group {
            if !auth.isAuthed {
                LoginView()
            } else if !roleResolved {
                VStack(spacing: 12) {
                    ProgressView().controlSize(.large).tint(DS.brand)
                    Text("Signing in…").font(.subheadline).foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Color(.systemGroupedBackground).ignoresSafeArea())
            } else if auth.isAdmin {
                AdminDashboardView()
            } else {
                ContentView()
            }
        }
        .task(id: auth.isAuthed) {
            roleResolved = false
            if auth.isAuthed { await auth.loadAdminFlag() }
            roleResolved = true
        }
    }
}

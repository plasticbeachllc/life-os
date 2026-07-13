import SwiftUI

struct RootTabView: View {
    @State private var model = AppModel.preview

    var body: some View {
        TabView(selection: $model.selectedTab) {
            TodayView(model: model)
                .tabItem { Label("Today", systemImage: "sun.max") }
                .tag(AppTab.today)

            InboxView(model: model)
                .tabItem { Label("Inbox", systemImage: "tray") }
                .badge(model.briefing.attentionCount)
                .tag(AppTab.inbox)

            TasksView(model: model)
                .tabItem { Label("Tasks", systemImage: "checklist") }
                .tag(AppTab.tasks)

            MoreView(model: model)
                .tabItem { Label("More", systemImage: "ellipsis") }
                .tag(AppTab.more)
        }
        .tint(.accentColor)
    }
}

#Preview {
    RootTabView()
}

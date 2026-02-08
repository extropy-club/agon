import { Route, A, RouteSectionProps } from "@solidjs/router";
import { lazy, createResource, Show } from "solid-js";
import { authMe, authLogout } from "./api";
import Login from "./pages/Login";

const Agents = lazy(() => import("./pages/Agents"));
const AgentDetail = lazy(() => import("./pages/AgentDetail"));
const Rooms = lazy(() => import("./pages/Rooms"));
const RoomDetail = lazy(() => import("./pages/RoomDetail"));
const RoomComposer = lazy(() => import("./pages/RoomComposer"));
const Metrics = lazy(() => import("./pages/Metrics"));
const Settings = lazy(() => import("./pages/Settings"));
const Guilds = lazy(() => import("./pages/Guilds"));

function App(props: RouteSectionProps) {
  const [user] = createResource(authMe);

  return (
    <Show when={!user.loading} fallback={<div class="loading">Loading...</div>}>
      <Show when={user()} fallback={<Login />}>
        {(u) => (
          <div class="app-shell">
            <nav class="sidebar">
              <h2>Agon Admin</h2>
              <div class="user-info">
                <img src={u().avatar_url} alt="" class="user-avatar" />
                <span>{u().login}</span>
              </div>
              <A href="/rooms" activeClass="active" end>
                Rooms
              </A>
              <A href="/rooms/new" activeClass="active">
                Create Room
              </A>
              <A href="/agents" activeClass="active">
                Agents
              </A>
              <A href="/metrics" activeClass="active">
                Metrics
              </A>
              <A href="/settings" activeClass="active">
                Settings
              </A>
              <A href="/guilds" activeClass="active">
                Discord Servers
              </A>

              <button class="logout-btn" onClick={() => authLogout().then(() => location.reload())}>
                Logout
              </button>
            </nav>
            <main class="main-content">{props.children}</main>
          </div>
        )}
      </Show>
    </Show>
  );
}

export default function AppRouter() {
  return (
    <Route path="/" component={App}>
      <Route path="/" component={Rooms} />
      <Route path="/rooms" component={Rooms} />
      <Route path="/rooms/new" component={RoomComposer} />
      <Route path="/rooms/:id" component={RoomDetail} />
      <Route path="/agents" component={Agents} />
      <Route path="/agents/:id" component={AgentDetail} />
      <Route path="/metrics" component={Metrics} />
      <Route path="/settings" component={Settings} />
      <Route path="/guilds" component={Guilds} />
    </Route>
  );
}

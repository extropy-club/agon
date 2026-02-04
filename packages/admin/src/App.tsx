import { Route, A, RouteSectionProps } from "@solidjs/router";
import { lazy } from "solid-js";

const Agents = lazy(() => import("./pages/Agents"));
const Rooms = lazy(() => import("./pages/Rooms"));
const RoomDetail = lazy(() => import("./pages/RoomDetail"));
const RoomComposer = lazy(() => import("./pages/RoomComposer"));
const Metrics = lazy(() => import("./pages/Metrics"));

function App(props: RouteSectionProps) {
  return (
    <div class="app-shell">
      <nav class="sidebar">
        <h2 style={{ "margin-bottom": "2rem" }}>Agon Admin</h2>
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
      </nav>
      <main class="main-content">{props.children}</main>
    </div>
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
      <Route path="/metrics" component={Metrics} />
    </Route>
  );
}

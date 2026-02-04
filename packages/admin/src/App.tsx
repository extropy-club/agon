import { Route, A, RouteSectionProps } from "@solidjs/router";
import { lazy, createSignal } from "solid-js";

const Agents = lazy(() => import("./pages/Agents"));
const Rooms = lazy(() => import("./pages/Rooms"));
const RoomDetail = lazy(() => import("./pages/RoomDetail"));
const RoomComposer = lazy(() => import("./pages/RoomComposer"));
const Metrics = lazy(() => import("./pages/Metrics"));

function App(props: RouteSectionProps) {
  const initialToken = (() => {
    try {
      return localStorage.getItem("agon.adminToken") ?? "";
    } catch {
      return "";
    }
  })();

  const [adminToken, setAdminToken] = createSignal(initialToken);

  const saveToken = () => {
    try {
      localStorage.setItem("agon.adminToken", adminToken());
    } catch {
      // ignore
    }
  };

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

        <div style={{ "margin-top": "2rem" }}>
          <div style={{ "font-size": "0.875rem", color: "var(--text-muted)" }}>Admin token</div>
          <input
            class="form-control"
            type="password"
            value={adminToken()}
            onInput={(e) => setAdminToken(e.currentTarget.value)}
            placeholder="Bearer token"
            style={{ "margin-top": "0.5rem" }}
          />
          <button class="btn" style={{ "margin-top": "0.5rem" }} onClick={saveToken}>
            Save
          </button>
          <div
            style={{ "font-size": "0.75rem", color: "var(--text-muted)", "margin-top": "0.5rem" }}
          >
            Sent as Authorization: Bearer ...
          </div>
        </div>
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

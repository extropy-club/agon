import { createResource, For, Show } from "solid-js";
import { A } from "@solidjs/router";
import { roomsApi } from "../api";

export default function Rooms() {
  const [rooms] = createResource(roomsApi.list);

  return (
    <div>
      <header
        style={{
          display: "flex",
          "justify-content": "space-between",
          "align-items": "center",
          "margin-bottom": "2rem",
        }}
      >
        <h1>Rooms</h1>
        <A href="/rooms/new" class="btn btn-primary">
          Create Room
        </A>
      </header>

      <div class="card">
        <Show when={!rooms.loading} fallback={<p>Loading rooms...</p>}>
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Topic</th>
                <th>Status</th>
                <th>Current Agent</th>
                <th>Turn</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              <For each={rooms()}>
                {(room) => (
                  <tr>
                    <td>{room.id}</td>
                    <td>{room.topic}</td>
                    <td>
                      <span class={`badge badge-${room.status}`}>{room.status}</span>
                    </td>
                    <td>{room.currentTurnAgentId}</td>
                    <td>{room.currentTurnNumber}</td>
                    <td>
                      <A href={`/rooms/${room.id}`} class="btn">
                        View
                      </A>
                    </td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </Show>
      </div>
    </div>
  );
}

// src/tui.tsx
import { effect as _$effect } from "@opentui/solid";
import { insert as _$insert } from "@opentui/solid";
import { memo as _$memo } from "@opentui/solid";
import { createComponent as _$createComponent } from "@opentui/solid";
import { createTextNode as _$createTextNode } from "@opentui/solid";
import { insertNode as _$insertNode } from "@opentui/solid";
import { setProp as _$setProp } from "@opentui/solid";
import { createElement as _$createElement } from "@opentui/solid";
import { createSignal, For, Show } from "solid-js";

// src/rpc.ts
import { Rpc } from "@opencode/plugin/rpc";
var text = { type: "string" };
var texts = { type: "array", items: text };
var object = (properties, required) => ({ type: "object", properties, required, additionalProperties: false });
var status = object({
  version: text,
  state: { enum: ["connected", "sign_in_required", "connecting", "disabled", "failed", "not_configured", "conflict", "host_untested"] },
  code: {
    enum: ["OPTIONS_INVALID", "SERVER_NAME_IN_USE", "HOST_UNTESTED", "CLIENT_ID_MISSING", "CLIENT_ID_INVALID", "AUTH_REQUIRED", "CONNECTION_FAILED", "SERVER_DISABLED"]
  },
  access: { enum: ["all", "ask-changes", "read-only"] },
  message: text,
  detail: text,
  nextStep: text,
  server: object({ name: text, url: text }, ["name", "url"]),
  client: object({ id: text, mode: { enum: ["public_pkce", "confidential"] }, source: { enum: ["options", "connect"] } }, ["id", "mode", "source"]),
  callback: text,
  callbackPort: { type: "integer" },
  scopes: texts,
  asksBefore: texts,
  tools: object({
    read: { type: "integer" },
    private: { type: "integer" },
    file: { type: "integer" },
    write: { type: "integer" },
    unknown: { type: "integer" },
    unknownNames: texts
  }, ["read", "private", "file", "write", "unknown", "unknownNames"]),
  unguardedAgents: texts,
  host: object({ version: { type: ["string", "null"] }, range: text, tested: { type: "boolean" } }, ["version", "range", "tested"]),
  shadowedSkills: { type: "array", items: object({ id: text, path: text }, ["id", "path"]) }
}, ["version", "state", "access", "message", "nextStep", "server", "asksBefore", "tools", "unguardedAgents", "host", "shadowedSkills"]);
var SlackRpc = Rpc.define({
  id: "slack.workspace",
  methods: {
    status: {
      input: object({}, []),
      output: status,
      errors: { unavailable: {} }
    }
  },
  events: {}
});
function isStatus(value) {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value;
  return status.required.every((key) => key in candidate) && typeof candidate.state === "string" && typeof candidate.message === "string" && typeof candidate.nextStep === "string";
}

// src/defaults.ts
var SERVER = "slack";

// src/host/events-list.ts
var EVENTS_LIST = "events_list";

// src/tools.ts
var KNOWN_TOOLS = {
  slack_search_public: "read",
  slack_search_channels: "read",
  slack_search_users: "read",
  slack_read_channel: "read",
  slack_read_thread: "read",
  slack_read_user_profile: "read",
  slack_read_canvas: "read",
  slack_list_channel_members: "read",
  slack_get_reactions: "read",
  slack_list_user_channels: "read",
  slack_read_list: "read",
  slack_search_emojis: "read",
  slack_search_public_and_private: "private",
  slack_read_file: "file",
  slack_send_message: "write",
  slack_send_message_draft: "write",
  slack_schedule_message: "write",
  slack_create_canvas: "write",
  slack_update_canvas: "write",
  slack_add_reaction: "write",
  slack_get_file_upload_url: "write",
  slack_complete_file_upload: "write",
  slack_create_conversation: "write",
  slack_create_list: "write",
  slack_update_list: "write",
  slack_add_list_record: "write",
  slack_update_list_record: "write"
};
var READ_TOOLS = Object.keys(KNOWN_TOOLS).filter((tool) => KNOWN_TOOLS[tool] === "read");

// src/permissions.ts
var READ_LIKE = Object.keys(KNOWN_TOOLS).filter((tool) => KNOWN_TOOLS[tool] === "read");
var OTHER_TOOLS = Object.keys(KNOWN_TOOLS).filter((tool) => KNOWN_TOOLS[tool] !== "read");
var rule = (action, effect) => ({ action, resource: "*", effect });
function defaultRules(access = "all") {
  const other = access === "all" ? "allow" : access === "ask-changes" ? "ask" : "deny";
  return [
    rule(`${SERVER}_*`, other),
    ...READ_LIKE.map((tool) => rule(`${SERVER}_${tool}`, "allow")),
    // The plugin's own events_list only reads, and Memory's collector runs it with no one there.
    rule(`${SERVER}_${EVENTS_LIST}`, "allow"),
    ...OTHER_TOOLS.map((tool) => rule(`${SERVER}_${tool}`, other))
  ];
}
var UNKNOWN_ACTION = `${SERVER}_.`;

// src/status.ts
function accessText(status2) {
  const rule2 = quote({ action: `${status2.server.name}_slack_read_file`, resource: "*", effect: "allow" });
  switch (status2.access) {
    case "all":
      return 'Every tool runs without asking: reads, the private-channel search, files, writes, sends and new Slack tools. Set the access option to "ask-changes" or "read-only" to restrict it, or add a later rule.';
    case "read-only":
      return `Reads run without asking; the private-channel search, the file read, every write and send, and new Slack tools are denied. To allow one, add a later rule such as ${rule2}.`;
    case "ask-changes":
      return `Reads run without asking. The private-channel search, the file read, every write and send, and new Slack tools ask first; choose "Always allow" when asked, or add a permissions rule such as ${rule2}.`;
  }
}
var quote = (rule2) => `{ "action": "${rule2.action}", "resource": "${rule2.resource}", "effect": "${rule2.effect}" }`;
var remedy = (access) => `[
${defaultRules(access).map((rule2) => `  ${quote(rule2)}`).join(",\n")}
]`;
function callbackRow(callback, port) {
  const register = "register exactly this URL in the app's Redirect URLs";
  if (port === void 0) return `${callback} (${register})`;
  return `${callback} (${register}, and forward it to http://127.0.0.1:${port}${new URL(callback).pathname}, where OpenCode listens)`;
}
function unknownTools(tools, access) {
  if (tools.unknown === 0) return "";
  const posture = access === "all" ? "new tools run too" : access === "read-only" ? "new tools are denied" : "ask first";
  const more = tools.unknown - tools.unknownNames.length;
  if (tools.unknownNames.length === 0) return `; ${tools.unknown} unknown (${posture})`;
  return `; ${tools.unknown} unknown (${posture}): ${tools.unknownNames.join(", ")}${more > 0 ? ` and ${more} more` : ""}`;
}
var CLIENT_SOURCE = { options: "set in plugin options", connect: "saved in /connect" };
function stateLabel(status2) {
  switch (status2.state) {
    case "sign_in_required":
      return "sign-in required";
    case "not_configured":
      return "not configured";
    case "host_untested":
      return "host untested";
    default:
      return status2.state;
  }
}
function statusRows(status2) {
  const { tools } = status2;
  const rows = [
    {
      label: "Connection",
      value: `${stateLabel(status2)}. ${status2.code === void 0 ? "" : `${status2.code}: `}${status2.message}${status2.detail === void 0 ? "" : ` ${status2.detail}`}`
    },
    { label: "Account", value: "Slack shows the account on its sign-in page; OpenCode does not store it." },
    { label: "Access", value: accessText(status2) },
    { label: "Server", value: `${status2.server.name} at ${status2.server.url}` }
  ];
  if (status2.client !== void 0) {
    const mode = status2.client.mode === "public_pkce" ? "public, PKCE" : "confidential, secret set";
    rows.push({ label: "Client", value: `${status2.client.id} (${mode}; ${CLIENT_SOURCE[status2.client.source]})` });
  }
  if (status2.callback !== void 0) rows.push({ label: "Callback", value: callbackRow(status2.callback, status2.callbackPort) });
  if (status2.scopes !== void 0) rows.push({ label: "Scopes", value: status2.scopes.join(" ") });
  if (status2.shadowedSkills.length > 0) {
    rows.push({
      label: "Skills",
      value: status2.shadowedSkills.map((skill) => `${skill.id} is shadowed by ${skill.path}, so agents load that file instead of this plugin's skill`).join("; ")
    });
  }
  rows.push({
    label: "Tools",
    value: `${tools.read} read, ${tools.private} private search, ${tools.file} file, ${tools.write} write${unknownTools(tools, status2.access)}`
  });
  rows.push({
    label: "Agents without default rules",
    value: status2.unguardedAgents.length === 0 ? "none" : `${status2.unguardedAgents.join(", ")}
${remedy(status2.access)}`
  });
  rows.push(
    { label: "OpenCode", value: `${status2.host.version ?? "unknown version"} (${status2.host.tested ? "tested" : "untested"}; supported range ${status2.host.range})` },
    { label: "Next step", value: status2.nextStep }
  );
  return rows;
}

// src/tui.tsx
var UNAVAILABLE = "STATUS_UNAVAILABLE: Slack status is unavailable. Next step: Press r to retry.";
var REFRESH_ON = ["server.connected", "mcp.status.changed", "agent.updated", "integration.updated", "credential.updated", "credential.switched"];
var NO_TOOLS_YET = "OpenCode lists Slack's tools just after it connects: press r to refresh.";
function dialogRows(status2) {
  const {
    read,
    private: search,
    file,
    write,
    unknown
  } = status2.tools;
  const empty = status2.state === "connected" && read + search + file + write + unknown === 0;
  return statusRows(status2).map((row) => empty && row.label === "Tools" ? {
    ...row,
    value: `${row.value}. ${NO_TOOLS_YET}`
  } : row);
}
var tui_default = {
  id: "slack.workspace.tui",
  setup(context) {
    const [status2, setStatus] = createSignal();
    const [problem, setProblem] = createSignal();
    const [loading, setLoading] = createSignal(false);
    let open = false;
    let generation = 0;
    let controller;
    const refresh = async () => {
      if (!open) return;
      const current = ++generation;
      controller?.abort();
      const request = controller = new AbortController();
      setLoading(true);
      try {
        const value = await context.client.rpc(SlackRpc).status({}, {
          location: context.location ?? context.data.location.default(),
          signal: request.signal
        });
        if (current !== generation) return;
        if (isStatus(value)) {
          setStatus(value);
          setProblem(void 0);
        } else {
          setProblem(UNAVAILABLE);
        }
      } catch {
        if (current === generation) setProblem(UNAVAILABLE);
      } finally {
        if (current === generation) setLoading(false);
      }
    };
    let unsubscribe = [];
    const stop = () => {
      open = false;
      generation++;
      controller?.abort();
      for (const off of unsubscribe.splice(0)) off();
    };
    const View = () => {
      context.keymap.layer(() => ({
        commands: [{
          id: "slack.workspace.refresh",
          title: "Refresh Slack status",
          bind: "r",
          run: () => void refresh()
        }]
      }));
      return (() => {
        var _el$ = _$createElement("box"), _el$2 = _$createElement("text"), _el$5 = _$createElement("text");
        _$insertNode(_el$, _el$2);
        _$insertNode(_el$, _el$5);
        _$setProp(_el$, "flexDirection", "column");
        _$setProp(_el$, "padding", 1);
        _$setProp(_el$, "gap", 1);
        _$insertNode(_el$2, _$createTextNode(`Slack`));
        _$insert(_el$, _$createComponent(Show, {
          get when() {
            return status2();
          },
          get fallback() {
            return (() => {
              var _el$6 = _$createElement("text");
              _$insert(_el$6, () => problem() ?? "Loading Slack status\u2026");
              _$effect((_$p) => _$setProp(_el$6, "fg", context.theme.text.muted, _$p));
              return _el$6;
            })();
          },
          children: (current) => (
            // The permission block can be long, so the rows scroll instead of pushing the footer off the dialog.
            (() => {
              var _el$7 = _$createElement("scrollbox"), _el$8 = _$createElement("box");
              _$insertNode(_el$7, _el$8);
              _$setProp(_el$7, "maxHeight", 28);
              _$setProp(_el$7, "scrollbarOptions", {
                visible: false
              });
              _$setProp(_el$8, "flexDirection", "column");
              _$insert(_el$8, _$createComponent(For, {
                get each() {
                  return dialogRows(current());
                },
                children: (row) => (() => {
                  var _el$9 = _$createElement("box"), _el$0 = _$createElement("text"), _el$1 = _$createElement("text");
                  _$insertNode(_el$9, _el$0);
                  _$insertNode(_el$9, _el$1);
                  _$setProp(_el$9, "flexDirection", "row");
                  _$setProp(_el$9, "gap", 1);
                  _$setProp(_el$0, "width", 29);
                  _$setProp(_el$0, "flexShrink", 0);
                  _$insert(_el$0, () => row.label);
                  _$setProp(_el$1, "flexShrink", 1);
                  _$insert(_el$1, () => row.value);
                  _$effect((_p$) => {
                    var _v$3 = context.theme.text.muted, _v$4 = context.theme.text.base;
                    _v$3 !== _p$.e && (_p$.e = _$setProp(_el$0, "fg", _v$3, _p$.e));
                    _v$4 !== _p$.t && (_p$.t = _$setProp(_el$1, "fg", _v$4, _p$.t));
                    return _p$;
                  }, {
                    e: void 0,
                    t: void 0
                  });
                  return _el$9;
                })()
              }));
              return _el$7;
            })()
          )
        }), _el$5);
        _$insert(_el$, _$createComponent(Show, {
          get when() {
            return _$memo(() => status2() !== void 0)() && problem() !== void 0;
          },
          get children() {
            var _el$4 = _$createElement("text");
            _$insert(_el$4, problem);
            _$effect((_$p) => _$setProp(_el$4, "fg", context.theme.text.muted, _$p));
            return _el$4;
          }
        }), _el$5);
        _$insert(_el$5, () => loading() ? "Refreshing\u2026" : "r refresh \xB7 esc close");
        _$effect((_p$) => {
          var _v$ = context.theme.text.base, _v$2 = context.theme.text.muted;
          _v$ !== _p$.e && (_p$.e = _$setProp(_el$2, "fg", _v$, _p$.e));
          _v$2 !== _p$.t && (_p$.t = _$setProp(_el$5, "fg", _v$2, _p$.t));
          return _p$;
        }, {
          e: void 0,
          t: void 0
        });
        return _el$;
      })();
    };
    const show = () => {
      context.ui.dialog.show(() => _$createComponent(View, {}), stop);
      context.ui.dialog.set({
        size: "large"
      });
      open = true;
      for (const off of unsubscribe.splice(0)) off();
      unsubscribe = REFRESH_ON.map((type) => context.data.on(type, () => void refresh()));
      void refresh();
    };
    context.keymap.layer(() => ({
      mode: "global",
      commands: [{
        id: "slack.workspace.status",
        title: "Slack: Status",
        group: "Slack",
        palette: true,
        slash: {
          name: "slack"
        },
        run: show
      }]
    }));
    return () => {
      const visible = open;
      stop();
      if (visible) context.ui.dialog.clear();
    };
  }
};
export {
  tui_default as default
};

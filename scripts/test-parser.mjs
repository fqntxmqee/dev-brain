import { parseFeishuMessageEvent } from "../src/gateway/feishu-events.ts";

const flatLine = JSON.stringify({
  chat_id: "oc_a444ebe708203fb4d38b18a902ac9859",
  chat_type: "p2p",
  content: "/help",
  create_time: "1780678398362",
  id: "om_x100b6d1ba129a8a4c00ad40a330230c",
  message_id: "om_x100b6d1ba129a8a4c00ad40a330230c",
  message_type: "text",
  sender_id: "ou_c96f59b4ef0e51f7d4d2678363a75ce8",
  timestamp: "1780678398652",
  type: "im.message.receive_v1",
});

const nestedLine = JSON.stringify({
  event_type: "im.message.receive_v1",
  message: {
    message_id: "om_nested_test",
    chat_id: "oc_nested_test",
    chat_type: "p2p",
    content: JSON.stringify({ text: "/status" }),
    message_type: "text",
  },
  sender: {
    sender_id: { open_id: "ou_nested_test" },
    name: "tester",
  },
});

console.log("flat:   ", parseFeishuMessageEvent(flatLine));
console.log("nested: ", parseFeishuMessageEvent(nestedLine));

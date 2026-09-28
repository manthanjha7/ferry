import { sleep } from "./cdp.mjs";

/** Type into whatever has focus in the attached page. */
export async function typeText(cdp, sessionId, text) {
  for (const ch of text) {
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", text: ch, key: ch, unmodifiedText: ch }, sessionId);
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: ch }, sessionId);
    await sleep(15);
  }
}

const KEYS = {
  Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
  Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  Slash: { key: "/", code: "Slash", windowsVirtualKeyCode: 191 },
  P: { key: "p", code: "KeyP", windowsVirtualKeyCode: 80 },
};

/** Press a named key, with modifiers (1 alt, 2 ctrl, 4 meta, 8 shift). */
export async function press(cdp, sessionId, name, modifiers = 0) {
  const k = KEYS[name];
  await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", modifiers, ...k, ...(modifiers ? { text: undefined } : {}) }, sessionId);
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", modifiers, ...k }, sessionId);
}

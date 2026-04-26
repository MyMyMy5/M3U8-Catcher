import { TELEGRAM_PAGE_BRIDGE_FILE } from "./background-constants.js";
import { isValidTabId } from "./background-utils.js";

const ensureTelegramPageBridge = (tabId) =>
  new Promise((resolve, reject) => {
    if (!isValidTabId(tabId)) {
      reject(new Error("Telegram download needs an active Telegram tab."));
      return;
    }
    if (!chrome?.scripting?.executeScript) {
      reject(new Error("Telegram download requires the scripting permission."));
      return;
    }
    chrome.scripting.executeScript(
      {
        target: { tabId },
        files: [TELEGRAM_PAGE_BRIDGE_FILE],
        world: "MAIN"
      },
      () => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve();
      }
    );
  });

export const sendTelegramDownloadToTab = async (tabId, payload) => {
  if (!isValidTabId(tabId)) {
    throw new Error("Telegram download needs an active Telegram tab.");
  }
  await ensureTelegramPageBridge(tabId);
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, payload, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response?.ok) {
        reject(new Error(response?.error || "Telegram tab did not accept download."));
        return;
      }
      resolve(response);
    });
  });
};

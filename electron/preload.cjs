"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("personaBridge", {
  getCharacter: () => ipcRenderer.invoke("persona:get-character"),
  getSnapshot: () => ipcRenderer.invoke("persona:get-snapshot"),
  hide: () => ipcRenderer.send("persona:hide"),
  subscribe: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on("persona:event", handler);
    return () => ipcRenderer.off("persona:event", handler);
  },
  subscribeSpeech: (listener) => {
    const handler = (_event, payload) =>
      listener({
        id: String(payload.id),
        wavBytes: new Uint8Array(payload.wavBytes),
      });
    ipcRenderer.on("persona:speech", handler);
    return () => ipcRenderer.off("persona:speech", handler);
  },
  subscribeSpeechCancellation: (listener) => {
    const handler = (_event, payload) => listener(String(payload.id));
    ipcRenderer.on("persona:speech-cancel", handler);
    return () => ipcRenderer.off("persona:speech-cancel", handler);
  },
  reportSpeechResult: (result) => {
    ipcRenderer.send("persona:speech-result", result);
  },
  reportSpeechReady: () => {
    ipcRenderer.send("persona:speech-ready");
  },
});

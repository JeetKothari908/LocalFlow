import React, { useContext } from "react";

export type UIPlatform = {
  layout: "desktop" | "mobile";
  exportDocument?: (text: string, filename: string) => void;
  copyTaskLink?: (id: string) => Promise<void>;
  taskRoute?: (id?: string) => void;
  readEditorDraft?: (id: string) => Promise<unknown>;
  writeEditorDraft?: (id: string, value: unknown) => Promise<void>;
};
export const PlatformContext = React.createContext<UIPlatform>({ layout: "desktop" });
export const usePlatform = () => useContext(PlatformContext);

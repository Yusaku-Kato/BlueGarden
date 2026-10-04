import { useEffect, useState } from "react";
import { watchWindowHidden } from "../infra/windowVisibility";

/** True while the app window is hidden or minimized. */
export function useWindowHidden(): boolean {
  const [hidden, setHidden] = useState(false);

  useEffect(() => watchWindowHidden(setHidden), []);

  return hidden;
}

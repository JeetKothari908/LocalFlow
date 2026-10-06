import React, { useContext, useEffect, useState } from "react";
import { utcToZonedTime } from "date-fns-tz";
export const TimeContext = React.createContext({ absolute: new Date(), zoned: new Date() });
export const useTime = (type: "absolute" | "zoned" = "zoned") => useContext(TimeContext)[type];
export function DeviceTimeProvider({ children, timeZone }: React.PropsWithChildren<{ timeZone?: string }>) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const timer = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(timer); }, []);
  const zoned = timeZone ? utcToZonedTime(now, timeZone) : now;
  return <TimeContext.Provider value={{ absolute: now, zoned }}>{children}</TimeContext.Provider>;
}

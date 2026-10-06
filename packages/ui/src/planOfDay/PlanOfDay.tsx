import React, { useEffect, useMemo, useState } from "react";
import { useTime } from "../time";
import { API } from "../types";
import { formatPlanTitleDate, getPlanDate, getYmd, parseYmd } from "../../../core/src/planOfDay/date";
import { Data, defaultData } from "../../../core/src/planOfDay/types";
import "./PlanOfDay.sass";

const PlanOfDay: React.FC<API<Data>> = ({ data = defaultData, setData }) => {
  const now = useTime();
  const activeDate = getPlanDate(now);
  const plans = data.plans ?? {};
  const selectedDate = data.selectedDate ?? activeDate;
  const plan = plans[selectedDate] ?? "";
  const [calendarOpen, setCalendarOpen] = useState(false);
  const selected = parseYmd(selectedDate) ?? now;
  const [visibleMonth, setVisibleMonth] = useState(
    new Date(selected.getFullYear(), selected.getMonth(), 1),
  );

  useEffect(() => {
    setVisibleMonth(new Date(selected.getFullYear(), selected.getMonth(), 1));
  }, [selectedDate]);

  useEffect(() => {
    if (data.activeDate === activeDate && data.selectedDate) return;

    setData({
      ...data,
      activeDate,
      selectedDate:
        !data.selectedDate || data.selectedDate === data.activeDate
          ? activeDate
          : data.selectedDate,
    });
  }, [activeDate, data, setData]);

  const updatePlan = (contents: string) =>
    setData({
      ...data,
      activeDate,
      selectedDate,
      plans: { ...plans, [selectedDate]: contents },
    });

  const selectDate = (date: string) => {
    if (!date) return;
    setData({ ...data, activeDate, selectedDate: date });
    setCalendarOpen(false);
  };

  const calendarDays = useMemo(() => {
    const start = new Date(
      visibleMonth.getFullYear(),
      visibleMonth.getMonth(),
      1 - visibleMonth.getDay(),
    );
    return Array.from({ length: 42 }, (_, index) => {
      const date = new Date(
        start.getFullYear(),
        start.getMonth(),
        start.getDate() + index,
      );
      return {
        date,
        key: getYmd(date),
        inMonth: date.getMonth() === visibleMonth.getMonth(),
      };
    });
  }, [visibleMonth]);

  const moveMonth = (offset: number) =>
    setVisibleMonth(
      new Date(visibleMonth.getFullYear(), visibleMonth.getMonth() + offset, 1),
    );

  return (
    <div className="PlanOfDay">
      <div className="panel">
        <div className="header">
          <button className="plan-today" onClick={() => selectDate(activeDate)}>Current day</button>
          <div className="title">
            <span>Plan of the Day </span>
            <div className="date-wrap">
              <button
                className="date-picker"
                onClick={() => setCalendarOpen(!calendarOpen)}
              >
                {formatPlanTitleDate(selectedDate)}
              </button>
              {calendarOpen && (
                <div className="calendar">
                  <div className="calendar-header">
                    <button onClick={() => moveMonth(-1)}>{"<"}</button>
                    <span>
                      {visibleMonth.toLocaleDateString(undefined, {
                        month: "short",
                        year: "numeric",
                      })}
                    </span>
                    <button onClick={() => moveMonth(1)}>{">"}</button>
                  </div>
                  <div className="calendar-grid week">
                    {["S", "M", "T", "W", "T", "F", "S"].map((day, index) => (
                      <span key={`${day}-${index}`}>{day}</span>
                    ))}
                  </div>
                  <div className="calendar-grid">
                    {calendarDays.map(({ date, key, inMonth }) => (
                      <button
                        key={key}
                        className={`${inMonth ? "" : "muted"}${
                          key === selectedDate ? " selected" : ""
                        }`}
                        onClick={() => selectDate(getYmd(date))}
                      >
                        {date.getDate()}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
        <textarea
          aria-label="Plan contents"
          value={plan}
          onChange={(event) => updatePlan(event.target.value)}
          spellCheck={true}
        />
      </div>
    </div>
  );
};

export default PlanOfDay;

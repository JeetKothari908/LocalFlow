import React from "react";
import { selectWidgets } from "../../db/select";
import { db, WidgetPosition, WidgetState } from "../../db/state";
import { useSelector, useValue } from "../../lib/db/react";
import Slot from "./Slot";
import "./Widgets.sass";

const Widgets: React.FC = () => {
  const focus = useValue(db, "focus");
  const showQuotes = useValue(db, "showQuotes");
  const allWidgets = useSelector(db, selectWidgets);

  // Hide quotes widget when showQuotes is false
  const widgets = allWidgets.filter(
    (widget) => widget.key !== "widget/quote" || showQuotes,
  );

  // TODO: one day we'll have `Array.groupBy` accepted by tc39
  const grouped = widgets.reduce<
    Partial<Record<WidgetPosition, WidgetState[]>>
  >(
    (carry, widget) => ({
      ...carry,
      [widget.display.position]: [
        ...(carry[widget.display.position] ?? []),
        widget,
      ],
    }),
    {},
  );

  const slots = Object.entries(grouped) as [WidgetPosition, WidgetState[]][];

  return (
    <div className="Widgets fullscreen">
      <div className="container">
        {!focus &&
          slots.map(([position, widgets]) => (
            <Slot key={position} position={position} widgets={widgets} />
          ))}
      </div>
    </div>
  );
};

export default Widgets;

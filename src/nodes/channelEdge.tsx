import { BezierEdge, type EdgeProps } from "@xyflow/react";
import { useEdgeChannelClasses } from "../channelStore";

/**
 * Domyślna krawędź grafu z kanałami wizualnymi: wrapper na BezierEdge, który
 * czyta klasy `gb-*` ze store'u kanałów — wygaszanie przy scrubie/selekcji idzie
 * przez CSS na tym <g>, bez przepisywania tablicy `edges` w App.
 */
export function ChannelEdge(props: EdgeProps) {
  const className = useEdgeChannelClasses(props.source, props.target);
  return (
    <g className={className}>
      <BezierEdge {...props} />
    </g>
  );
}

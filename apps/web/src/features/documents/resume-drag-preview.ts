/** Use an independent bitmap so native dragging never snapshots the resume grid or table. */
export function setResumeDragPreview(
	dataTransfer: Pick<DataTransfer, "setDragImage">,
	name: string,
	sourceDocument: Document,
) {
	const canvas = sourceDocument.createElement("canvas");
	canvas.width = 280;
	canvas.height = 48;
	const context = canvas.getContext("2d");
	if (!context) return;

	const dark = sourceDocument.documentElement.classList.contains("dark");
	context.fillStyle = dark ? "#24231f" : "#ffffff";
	context.strokeStyle = dark ? "#565449" : "#d8d7d0";
	context.lineWidth = 1;
	context.beginPath();
	context.roundRect(1.5, 1.5, 277, 45, 8);
	context.fill();
	context.stroke();

	// A small document with a folded corner, independent of PDF thumbnails and page layout.
	context.strokeStyle = dark ? "#9bbf93" : "#4e7c50";
	context.lineWidth = 1.5;
	context.lineJoin = "round";
	context.beginPath();
	context.moveTo(15, 12);
	context.lineTo(26, 12);
	context.lineTo(32, 18);
	context.lineTo(32, 36);
	context.lineTo(15, 36);
	context.closePath();
	context.moveTo(26, 12);
	context.lineTo(26, 18);
	context.lineTo(32, 18);
	context.moveTo(19, 25);
	context.lineTo(28, 25);
	context.moveTo(19, 30);
	context.lineTo(26, 30);
	context.stroke();

	context.fillStyle = dark ? "#efeeeb" : "#1c1b15";
	context.font = "500 13px system-ui, sans-serif";
	context.textBaseline = "middle";
	const label = name.replace(/\s+/g, " ").trim();
	const characters = Array.from(label);
	while (characters.length && context.measureText(`${characters.join("")}…`).width > 222) characters.pop();
	const caption = context.measureText(label).width <= 222 ? label : `${characters.join("")}…`;
	context.fillText(caption, 44, 24);

	dataTransfer.setDragImage(canvas, 20, 24);
	return canvas;
}

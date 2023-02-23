import { Server as SocketServer } from "socket.io";
import type { Server as HTTPServer } from "node:http";
import { TILE_COLORS, TILE_SHAPES } from "../common/constants.js";
import type {
	ClientToServerEvents,
	InterServerEvents,
	PlacedTile,
	Rooms,
	ServerToClientEvents,
	SocketData,
	Tile,
} from "../common/types.js";

const fullDeck = TILE_COLORS.map((color) => {
	return TILE_SHAPES.map((shape) => {
		return Array<Tile>(3).fill({ color, shape });
	});
}).flat(2);
const rooms: Rooms = {};
const hands: Record<string, Tile[]> = {};

export default function connectIo(server: HTTPServer) {
	const io = new SocketServer<
		ClientToServerEvents,
		ServerToClientEvents,
		InterServerEvents,
		SocketData
	>(server);

	io.on("connection", (socket) => {
		socket.once("mounted", () => socket.emit("roomsListUpdate", getPublicRooms()));
		socket
			.on("createRoom", (roomData, callback) => {
				const roomId = roomData.roomId.trim();
				if (!roomId || rooms[roomId]) return callback(false);
				const deck = Array.from(fullDeck);
				const room = (rooms[roomId] ??= {
					deck,
					board: { [0]: { [0]: { ...getRandomTile(deck, true), x: 0, y: 0 } } },
					host: socket.id,
					players: [],
					auth: roomData.auth,
					private: roomData.private,
				});

				rooms[roomId]?.players.push(socket.id);

				socket.once("mounted", () => io.emit("roomsListUpdate", getPublicRooms()));

				callback(room);
			})
			.on("joinRoom", (roomId, callback) => {
				rooms[roomId]?.players.push(socket.id);
				const room = rooms[roomId];
				if (!room) return callback("UNDEFINED_ROOM");
				socket.join(roomId);
				const { deck } = room;

				callback((hands[socket.id] ??= generateHand(deck)));
				socket.once("mounted", () => {
					Object.values(room.board)
						.flatMap((column) => Object.values(column))
						.forEach((tile) => socket.emit("tilePlaced", tile));
					io.emit("roomsListUpdate", getPublicRooms());
				});
			})
			.on("placeTile", (location, index, callback) => {
				const roomId = [...socket.rooms.values()][1];
				if (!roomId) return callback("NOT_IN_ROOM");
				const room = rooms[roomId];
				if (!room) return callback("UNDEFINED_ROOM");
				// STEP 1: Gather base information.
				const hand = hands[socket.id] ?? generateHand(room.deck);
				const tile = hand[Number(index)];
				if (!tile) return callback("MISSING_TILE");
				const placed = { ...tile, ...location };

				// STEP 2: Check for collisions.
				const row = room.board[Number(location.y)] ?? {};
				if (row[location.x]) return callback("ALREADY_PLACED");

				// STEP 3: Check for neighbors.
				let top = room.board[location.y - 1]?.[Number(location.x)],
					bottom = room.board[location.y + 1]?.[Number(location.x)],
					right = row[location.x + 1],
					left = row[location.x - 1];
				if (!top && !bottom && !right && !left) return callback("NO_NEIGHBORS");

				// STEP 4: Check neighborhood to verify consistency.
				const neighborhood: { row: PlacedTile[]; column: PlacedTile[] } = {
					row: [],
					column: [],
				};
				//Step 4.0-4.3: Get neighborhood
				if (right || left) {
					if (left) {
						do neighborhood.row.unshift(left);
						while ((left = row[left.x - 1]));
					}
					neighborhood.row.push(placed);
					if (right) {
						do neighborhood.row.push(right);
						while ((right = row[right.x + 1]));
					}
				}
				if (top || bottom) {
					if (top) {
						do neighborhood.column.unshift(top);
						while ((top = room.board[top.y - 1]?.[Number(location.x)]));
					}
					neighborhood.column.push(placed);
					if (bottom) {
						do neighborhood.column.push(bottom);
						while ((bottom = room.board[bottom.y + 1]?.[Number(location.x)]));
					}
				}
				// Step 4.4: Check that the color OR the shape of each row item is the same
				// Step 4.5: Check that the other has no duplicates
				// Steps 4.6-4.7: Repeat for columns
				const rowResult = verifyLine(neighborhood.row);
				if (rowResult) return callback(`${rowResult}_ROW_ITEMS`);
				const columnResult = verifyLine(neighborhood.column);
				if (columnResult) return callback(`${columnResult}_COLUMN_ITEMS`);

				// STEP 5: Place the tile.
				row[Number(location.x)] = placed;
				room.board[Number(location.y)] = row;
				io.to(roomId).emit("tilePlaced", placed);

				// STEP 6: Update the user's hand.
				const newTile = getRandomTile(room.deck);
				if (newTile) hand[Number(index)] = newTile;
				else hand.splice(index, 1);
				callback((hands[socket.id] = sortHand(hand)));
			})
			.on("disconnect", () => {
				// TODO
			});
	});
}

function getRandomTile(deck: Tile[], required: true): Tile;
function getRandomTile(deck: Tile[], required?: false): Tile | undefined;
function getRandomTile(deck: Tile[], required = false): Tile | undefined {
	const index = Math.floor(Math.random() * deck.length);
	const tile = deck[index];
	if (!tile && required) throw new RangeError("Deck is empty");
	deck.splice(index, 1);
	return tile;
}

function generateHand(deck: Tile[]) {
	const hand = [];
	while (deck.length > 0 && hand.length < 6) {
		hand.push(getRandomTile(deck, true));
	}
	return sortHand(hand);
}

function sortHand(hand: Tile[]) {
	return hand.sort(
		(one, two) =>
			TILE_COLORS.indexOf(one.color) - TILE_COLORS.indexOf(two.color) ||
			TILE_SHAPES.indexOf(one.shape) - TILE_SHAPES.indexOf(two.shape),
	);
}

function verifyLine(line: PlacedTile[]) {
	const isSameColor = line.every((tile) => tile.color === line[0]?.color);
	const isSameShape = line.every((tile) => tile.shape === line[0]?.shape);
	if (!(isSameColor || isSameShape)) return "INCONSISTENT";

	return (
		line.some((tile, index) => {
			const key = isSameColor ? tile.shape : tile.color;
			return (
				line.findIndex((item) => item[isSameColor ? "shape" : "color"] === key) !== index
			);
		}) && "DUPLICATE"
	);
}

function getPublicRooms() {
	return Object.fromEntries(Object.entries(rooms).filter(([, room]) => !room.private));
}
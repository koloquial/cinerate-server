const express = require("express");
const app = express();
const http = require("http");
const { Server } = require('socket.io');
const cors = require("cors");

app.use(cors());

const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: "http://localhost:3000",
        methods: ["GET", "POST"],
    }
})

//runs on conecction
io.on("connection", (socket) => {
    console.log('user connected:', socket.id);

    socket.on("disconnect", () => {
        console.log('disconnected', socket.id);
    })
    //join a room
    socket.on("join_room", (data) => {
        socket.join(data);
    })

    socket.on("send_message", (data) => {
        console.log("data", data);

        //send to everyone but yourself
        // socket.broadcast.emit("recieve_message", data);

        //send to specific room
        socket.to(data.room).emit("recieve_messge", data);
    });
});

server.listen(3001, () => {
    console.log('server online.');
})
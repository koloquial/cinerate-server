const express = require("express");
const app = express();
const http = require("http");
const { Server } = require('socket.io');
const cors = require("cors");

app.use(cors());

const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"],
    }
})

const online = [];

const rooms = [];

//runs on conecction
io.on("connection", (socket) => {
    console.log('User Connected:', socket.id);

    //push user to online
    online.push({id: socket.id, name: ''});

    console.log('Online Users', online);

    socket.on("disconnect", () => {
        console.log('User Disconnected', socket.id);

        //remove user from online users
        for(let i = 0; i < online.length; i++){
            if(online[i].id === socket.id){
                online.splice(i, 1);
                
            }
        }

        console.log('Online Users:', online);
    })

    //client creates room
    socket.on("create_room", (data) => {
        console.log('Create Room:', data);

        //join room
        socket.join(data.id);

        //get player from online[]
        let player;
        for(let i = 0; i < online.length; i++){
            if(online[i].id === data.id){
                player = online[i];
            }
        }

        const room = { id: data.id, players: [player], chat: [], dealer: [], scores: [] };

        //update room with player in it
        io.in(data.id).emit("update_room", room)

        //push room into rooms[]
        rooms.push(room);

        console.log('Rooms:', rooms)

        //update stage
        io.to(data.id).emit("stage_update", {stage: 'await'});

        //update notifcation
        io.to(data.id).emit("notification", {message: 'Room created.'});
    })

    //client join a room
    socket.on("join_room", (data) => {
        console.log('Join Room:', data);

        //join room
        socket.join(data.room);

        //get player info from online[]
        let player;
        for(let i = 0; i < online.length; i++){
            if(online[i].id === data.id){
               player = online[i];
            }
        }

        //find room
        let room;
        for(let i = 0; i < rooms.length; i++){
            if(rooms[i].id === data.room){
                room = rooms[i];
            }
        }

        //push player into room           
        room.players.push(player);

        //update room
        io.in(room.id).emit("update_room", room);
        
        //update chat
        io.to(data.room).emit("receive_message", room.chat);

        //update stage
        io.to(data.id).emit("stage_update", {stage: 'await'});

        //update notifcation
        io.to(data.id).emit("notification", {message: 'Joined room.'});
    })

    //update user name
    socket.on("update_name", (data) => {
        for(let i = 0; i < online.length; i++){
            if(online[i].id === data.id){
                online[i].name = data.name;
                io.to(data.id).emit("notification", {message: 'Name updated.'})
            }
        }
        console.log('online users:', online);
    })

    //send message
    socket.on("send_message", (data) => {
        console.log('Send Message:', data)

        //find room
        let room;
        for(let i = 0; i < rooms.length; i++){
            if(rooms[i].id === data.room){
                room = rooms[i];
            }
        }
        room.chat.push({name: data.name, message: data.message});
        
        io.to(data.room).emit("receive_message", room.chat);
    })
});

server.listen(process.env.PORT, () => {
    console.log('server online.');
})
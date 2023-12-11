const express = require("express");
const app = express();
const http = require("http");
const { Server } = require('socket.io');
const cors = require("cors");

app.use(cors());

const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: ["http://localhost:3000"],
        methods: ["GET", "POST"],
    }
})

const online = [];

const rooms = [];

//runs on conecction
io.on("connection", (socket) => {
    console.log('User Connected:', socket.id);
    //push user to online
    online.push({id: socket.id, name: '', score: 0});
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

        const room = { 
            id: data.id, 
            players: [player], 
            chat: [], 
            dealer: '', 
            moviesUsed: [], 
            guesses: [], 
            critMovie: [],
            winner: []
        };

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

    //start game
    socket.on("start_game", (data) => {
        console.log("Start Game:", data.room);
        //find room
        let room;
        for(let i = 0; i < rooms.length; i++){
            if(rooms[i].id === data.room){
                room = rooms[i];
            }
        }

        //random dealer
        let random = Math.floor(Math.random() * room.players.length);
        room.dealer = room.players[random];

        //update room
        io.in(room.id).emit("update_room", room);

        //update stage
        io.to(room.id).emit("stage_update", {stage: 'assign-movie'});
        
        //update notifcation
        io.to(data.id).emit("notification", {message: 'Game started.'});
    })

    //movie selected
    socket.on("movie_selected", (data) => {
        console.log("Movie Selected:", data)

        //find room
        let room;
        for(let i = 0; i < rooms.length; i++){
            if(rooms[i].id === data.room.id){
                room = rooms[i];
            }
        }

        //push movie into critMovie[]
        room.critMovie.push(data.movie);

        //push into movieUsed[]
        room.moviesUsed.push(data.movie);

        //update room
        io.in(room.id).emit("update_room", room);

        //update stage
        io.to(room.id).emit("stage_update", {stage: 'cast-vote'});
        
        //update notifcation
        io.to(data.id).emit("notification", {message: 'Movie selected.'});
    })

    //cast vote
    socket.on("cast_vote", (data) => {
        console.log("Cast Vote:", data);

        //find room
        let room;
        for(let i = 0; i < rooms.length; i++){
            if(rooms[i].id === data.room.id){
                room = rooms[i];
            }
        }

        //get user
        let user;
        for(let i = 0; i < room.players.length; i++){
            if(room.players[i].id === data.id){
                user = room.players[i];
            }
        }

        //push user and vote into guesses
        room.guesses.push({player: user, vote: data.vote});

        //check if all guesses are cast
        if(room.guesses.length === room.players.length){
            console.log('All guesses cast.');

            //update room
            io.in(room.id).emit("update_room", room);

            //update stage
            io.to(room.id).emit("stage_update", {stage: 'view-round-results'});
        
            //update notifcation
            io.to(room.id).emit("notification", {message: 'Round over.'});
        }else{
            console.log('Awaiting guesses.');

            //update stage (private)
            if(data.id === room.id){

            }else{
                //update stage
                io.to(data.id).emit("stage_update", {stage: 'await-guesses'});
                
                //update notifcation
                io.to(data.id).emit("notification", {message: 'Vote cast.'});
            }
            
            
        }
    })

    //next round
    socket.on("next_round", (data) => {
        console.log("Next Round:", data);
        //find room
        let room;
        for(let i = 0; i < rooms.length; i++){
            if(rooms[i].id === data.id){
                room = rooms[i];
            }
        }

        //assign dealer
        let target;
        if(room.winner.length > 1){
            //random dealer
            let random = Math.floor(Math.random() * winner.length);
            target = room.winner[random];
        }else{
            target = room.winner;
        }

        //use target to find player and assign dealer
        for(let i = 0; i < players.length; i++){
            if(target.player.id === players[i].id){
                room.dealer = players[i]
            }
        }

        //update room variables
        room.winner = [];
        room.guesses = [];
        room.critMovie = [];

        //update room
        io.in(room.id).emit("update_room", room);

        //update stage
        io.to(room.id).emit("stage_update", {stage: 'assign-movie'});
    
        //update notifcation
        io.to(room.id).emit("notification", {message: 'Next round.'});
    })
});

server.listen(3001, () => {
    console.log('server online.');
})
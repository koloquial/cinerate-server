const express = require("express");
const app = express();
const http = require("http");
const { Server } = require('socket.io');
const cors = require("cors");
const md5 = require('md5');

app.use(cors());

const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: ["http://localhost:3000"],
        methods: ["GET", "POST"],
    }
})

const online = {};

const rooms = {};

function calculateWinner(guesses, target){
    const contenders = [];
    //check if vote is <= target
    //guesses above are disqualified
    guesses.forEach(guess => {
        if(parseFloat(guess.vote) <= parseFloat(target)){
            contenders.push(guess);
        }
    });

    //calculate high vote
    let high = null;
    const ties = [];
    contenders.forEach(contender => {
        //if high vote hasnt been set
        if(high === null){
            high = contender;
        }else if(parseFloat(contender.vote) > parseFloat(high.vote)){
            //set new high
            high = contender;
        }else if(parseFloat(contender.vote) === parseFloat(high.vote)){
            //contender is equal to high
            ties.push(contender);
        }
    })

    let result = [];
    result.push(high);
    //remove any ties that are lower than high vote
    ties.forEach(tie => {
        if(parseFloat(tie) === parseFloat(high.vote)){
            result.push(tie);
        }
    });
    return result;
}

//runs on conecction
io.on("connection", (socket) => {
    //add user socket id to online{}
    online[socket.id] = {
        id: socket.id,
        name: socket.id.substring(0, 5), 
        score: 0
    }

    console.log('online:', online)

    //send user socket info
    io.to(socket.id).emit("entry", online[socket.id]);

    //disconnect
    socket.on("disconnect", () => {
        //remove user from online users
        delete online[socket.id];
    })

    //update user name
    socket.on("update_name", ({ id, name }) => {
        //update name
        online[id].name = name;
        //send user socket info
        io.to(id).emit("entry", online[id]);
        //send notification
        io.to(id).emit("notification", {message: 'Name updated.'});
    })

    //client creates room
    socket.on("create_room", ({ id }) => {
        //create room ID
        const roomID = md5(id);
        //join room
        socket.join(roomID);
        //create room obj
        const room = { 
            id: roomID,
            active: false,
            host: online[id],
            players: [online[id]], 
            chat: [], 
            dealer: null, 
            movies: [], 
            guesses: [], 
            critMovie: null,
            winners: []
        };
        //add room to rooms{}
        rooms[roomID] = room;
        //update room
        io.in(id).emit("update_room", room)
        //update stage
        io.to(id).emit("stage_update", {stage: 'await-players'});
        //update notifcation
        io.to(id).emit("notification", {message: 'Room created.'});
    })

    //client join a room
    socket.on("join_room", ({ id, room}) => {
        //if game is not active allow user to join
        if(!rooms[room].active){
            //join room
            socket.join(room);

            //push player into room           
            rooms[room].players.push(online[id]);

            //update room
            io.in(room).emit("update_room", rooms[room]);

            //update stage
            io.to(id).emit("stage_update", {stage: 'await-players'});

            //update notifcation
            io.to(id).emit("notification", {message: 'Joined room.'});
        }else{
            //game is already active
            io.to(id).emit("notification", {message: 'Game already active.'});
        }
    })

    //send message
    socket.on("send_message", ({ id, name, message }) => {
        //push message into room.chat[]
        rooms[id].chat.push({name, message});
        //remove old messages
        if(rooms[id].chat.length > 10){
            rooms[id].chat.shift();
        }
        //update room        
        io.in(id).emit("update_room", rooms[id]);
    })

    //start game
    socket.on("start_game", ({ id }) => {
        //activate game
        rooms[id].active = true;
        //assign random dealer
        let random = Math.floor(Math.random() * rooms[id].players.length);
        rooms[id].dealer = rooms[id].players[random];
        //update room
        io.in(id).emit("update_room", rooms[id]);
        //update stage
        io.in(id).emit("stage_update", {stage: 'assign-movie'});
        //update notifcation
        io.in(id).emit("notification", {message: 'Game started.'});
    })

    //movie selected
    socket.on("movie_selected", ({ room, movie }) => {
        //push movie into critMovie[]
        rooms[room].critMovie = movie;

        //push into movies[]
        rooms[room].movies.push(movie);

        //update room
        io.in(room).emit("update_room", rooms[room]);

        //update stage
        io.in(room).emit("stage_update", {stage: 'cast-vote'});
        
        //update notifcation
        io.in(room).emit("notification", {message: 'Movie selected.'});
    })

    //re-assign dealer
    socket.on("assign_dealer", ({ room }) => {
        //update stage
        io.in(room).emit("stage_update", {stage: 'assign-dealer'});

        //update notifcation
        io.in(room).emit("notification", {message: 'Dealer time expired.'});
        
        setTimeout(() => {
            //assign random dealer
            let valid = false;
            let random;
            while(!valid){
                random = Math.floor(Math.random() * rooms[room].players.length);
                if(rooms[room].players[random].id !== rooms[room].dealer.id){
                    valid = true;
                }
            }
            rooms[room].dealer = rooms[room].players[random];
            //update room
            io.in(room).emit("update_room", rooms[room]);

            //update stage
            io.in(room).emit("stage_update", {stage: 'assign-movie'});

            //update time
            io.in(room).emit("update_time", 30);

            //update notifcation
            io.in(room).emit("notification", {message: 'New dealer.'});
        }, 3000)
    })

    //cast vote
    socket.on("cast_vote", ({ id, room, vote}) => {
        //push user guess into guesses[]
        rooms[room].guesses.push({ user: online[id], vote });
        //check if all guesses are cast
        if(rooms[room].guesses.length === rooms[room].players.length){
            //generate an array of winners
            const winners = calculateWinner(rooms[room].guesses, rooms[room].critMovie.imdbRating);
            //push winners into rooms[room].winners
            winners.forEach(winner => {
                rooms[room].winners.push(winner);
            })
            //update scores if winners !== null
            if(winners[0] !== null){
                //update scores
                for(let i = 0; i < winners.length; i++){
                    for(let j = 0; j < rooms[room].players.length; j++){
                        if(winners[i].user.id === rooms[room].players[j].id){
                            rooms[room].players[j].score = rooms[room].players[j].score + 1;
                        }
                    }
                }
            }
            
            //update room
            io.in(room).emit("update_room", rooms[room]);
            //update stage
            io.in(room).emit("stage_update", {stage: 'round-over'});
            //update notifcation
            io.in(room).emit("notification", {message: 'Round over.'});
        }else{
            /* PROBLEM:    
            //update stage (private)
            // socket.to(id).emit("stage_update", {stage: 'await-guesses'});
            // stage is set by client as the above line sends to all clients
             */ 
            //update notifcation (private)
            socket.to(id).emit("notification", {message: 'Vote cast.'});
        }
    })

    //next round
    socket.on("next_round", ({ room }) => {
        //if winner !== null
        if(rooms[room].winners[0] !== null){
            if(rooms[room].winners.length > 1){
                //assign random dealer from winners array
                let random = Math.floor(Math.random() * rooms[room].winners.length);
                rooms[room].dealer = rooms[room].winners[random].user;
            }else{
                //assign dealer to the winner
                rooms[room].dealer = rooms[room].winners[0].user;
            }
        }else{
            //assign random dealer
            let random = Math.floor(Math.random() * rooms[room].players.length);
            rooms[room].dealer = rooms[room].players[random];
        }

        //update room variables
        rooms[room].winners.splice(0, rooms[room].winners.length);
        rooms[room].guesses.splice(0, rooms[room].guesses.length);
        rooms[room].critMovie = null;

        //update stage
        io.in(room).emit("stage_update", {stage: 'assign-movie'});

        //update room
        io.in(room).emit("update_room", rooms[room]);

        //update time
        io.in(room).emit("update_time", 30);

        //update notifcation
        io.in(room).emit("notification", {message: 'Next round.'});
        
    })
    
    //game over
    socket.on("game_over", ({ room }) => {
        //update stage
        io.in(room).emit("stage_update", {stage: 'game-over'});

        //update notifcation
        io.in(room).emit("notification", {message: 'Game over.'});
    })

});

server.listen(3001, () => {
    console.log('server online.');
})
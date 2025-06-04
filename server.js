// server.js - WebSocket server for "Who Said What?" multiplayer game
const WebSocket = require('ws');
const http = require('http');
const url = require('url');

// Game state
class GameRoom {
    constructor() {
        this.players = new Map();
        this.gameState = 'lobby'; // lobby, questions, playing, finished
        this.questions = [
            { type: 'text', question: "What's your favorite movie?" },
            { type: 'text', question: "What's your biggest fear?" },
            { type: 'youtube', question: "What's your favorite song? (Share YouTube link)" },
            { type: 'text', question: "What's your dream vacation destination?" },
            { type: 'image', question: "Upload a photo of you when you were little" }
        ];
        this.answers = new Map(); // playerId -> answers array
        this.currentRound = 0;
        this.totalRounds = 5;
        this.scores = new Map();
        this.votes = new Map(); // playerId -> votedForPlayerId
        this.currentRoundData = null;
        this.roundTimer = null;
        this.hostId = null;
    }

    addPlayer(ws, name) {
        const playerId = this.generatePlayerId();
        const isHost = this.players.size === 0;

        if (isHost) {
            this.hostId = playerId;
        }

        const player = {
            id: playerId,
            name: name,
            ws: ws,
            isHost: isHost,
            ready: false,
            answered: false
        };

        this.players.set(playerId, player);
        this.scores.set(playerId, 0);
        ws.playerId = playerId;

        return player;
    }

    removePlayer(playerId) {
        this.players.delete(playerId);
        this.answers.delete(playerId);
        this.scores.delete(playerId);
        this.votes.delete(playerId);

        // If host left, assign new host
        if (playerId === this.hostId && this.players.size > 0) {
            const newHost = this.players.values().next().value;
            if (newHost) {
                newHost.isHost = true;
                this.hostId = newHost.id;
            }
        }
    }

    generatePlayerId() {
        return 'player_' + Math.random().toString(36).substr(2, 9);
    }

    getPlayersData() {
        const playersData = {};
        this.players.forEach((player, id) => {
            playersData[id] = {
                name: player.name,
                isHost: player.isHost,
                ready: player.ready
            };
        });
        return playersData;
    }

    broadcast(message, excludeId = null) {
        const messageStr = JSON.stringify(message);
        this.players.forEach((player, id) => {
            if (id !== excludeId && player.ws.readyState === WebSocket.OPEN) {
                player.ws.send(messageStr);
            }
        });
    }

    sendToPlayer(playerId, message) {
        const player = this.players.get(playerId);
        if (player && player.ws.readyState === WebSocket.OPEN) {
            player.ws.send(JSON.stringify(message));
        }
    }

    startQuestions(totalRounds) {
        this.totalRounds = totalRounds;
        this.gameState = 'questions';
        this.broadcast({
            type: 'questionsStarted'
        });
    }

    submitAnswer(playerId, questionIndex, answer) {
        if (!this.answers.has(playerId)) {
            this.answers.set(playerId, {});
        }
        this.answers.get(playerId)[questionIndex] = answer;

        const player = this.players.get(playerId);
        if (player) {
            player.answered = true;
        }
    }

    markPlayerReady(playerId) {
        const player = this.players.get(playerId);
        if (player) {
            player.ready = true;
            console.log(`Player ${playerId} marked as ready`);

            // Check if all players are ready
            const allReady = Array.from(this.players.values()).every(p => p.ready);
            const readyCount = Array.from(this.players.values()).filter(p => p.ready).length;

            console.log(`Ready check: ${readyCount}/${this.players.size} players ready, allReady: ${allReady}`);

            if (allReady && this.players.size > 1) {
                console.log('All players ready! Changing state to readyToStart');
                // Important: Change game state to ready to start
                this.gameState = 'readyToStart';
                this.broadcast({
                    type: 'allPlayersReady'
                });
            }
        }
    }

    startGame() {
        // Only allow starting if we're in the right state
        if (this.gameState !== 'readyToStart') {
            console.log('Attempted to start game but not ready. Current state:', this.gameState);
            return false;
        }

        this.gameState = 'playing';
        this.currentRound = 0;
        this.startNextRound();
        return true;
    }

    startNextRound() {
        this.currentRound++;
        this.votes.clear();

        if (this.currentRound > this.totalRounds) {
            this.endGame();
            return;
        }

        // Select random question/answer pair
        const roundData = this.selectRandomQuestionAnswer();
        this.currentRoundData = roundData;

        this.broadcast({
            type: 'gameStarted',
            roundData: roundData,
            round: this.currentRound,
            totalRounds: this.totalRounds
        });

        // Start round timer
        this.startRoundTimer();
    }

    selectRandomQuestionAnswer() {
        const playerIds = Array.from(this.players.keys());
        const randomPlayerId = playerIds[Math.floor(Math.random() * playerIds.length)];
        const playerAnswers = this.answers.get(randomPlayerId);

        if (!playerAnswers || Object.keys(playerAnswers).length === 0) {
            // Fallback if no answers
            console.log('Warning: No answers found for player', randomPlayerId);
            return {
                question: "What's your favorite color?",
                answer: "Blue",
                answerType: 'text',
                correctPlayer: randomPlayerId
            };
        }

        const questionIndices = Object.keys(playerAnswers);
        const randomQuestionIndex = questionIndices[Math.floor(Math.random() * questionIndices.length)];
        const question = this.questions[parseInt(randomQuestionIndex)];
        const answer = playerAnswers[randomQuestionIndex];

        return {
            question: question.question,
            answer: answer,
            answerType: question.type,
            correctPlayer: randomPlayerId
        };
    }

    submitVote(playerId, votedForPlayerId) {
        if (playerId === votedForPlayerId) {
            return; // Can't vote for yourself
        }

        this.votes.set(playerId, votedForPlayerId);

        // Check if all eligible players have voted
        // Eligible voters = all players except the one who gave the answer
        const eligibleVoters = this.players.size - 1;
        if (this.votes.size >= eligibleVoters) {
            this.processRoundResults();
        }
    }

    processRoundResults() {
        // Clear timer
        if (this.roundTimer) {
            clearTimeout(this.roundTimer);
            this.roundTimer = null;
        }

        // Calculate scores
        this.votes.forEach((votedFor, voter) => {
            if (votedFor === this.currentRoundData.correctPlayer) {
                const currentScore = this.scores.get(voter) || 0;
                this.scores.set(voter, currentScore + 1);
            }
        });

        // Send round results
        const scoresData = {};
        this.scores.forEach((score, playerId) => {
            scoresData[playerId] = score;
        });

        this.broadcast({
            type: 'roundResults',
            correctPlayer: this.currentRoundData.correctPlayer,
            votes: Object.fromEntries(this.votes),
            scores: scoresData
        });

        // Start next round after delay
        setTimeout(() => {
            if (this.currentRound < this.totalRounds) {
                this.startNextRound();
            } else {
                this.endGame();
            }
        }, 3000);
    }

    startRoundTimer() {
        this.roundTimer = setTimeout(() => {
            // Force end round if time runs out
            console.log('Round timer expired, processing results');
            this.processRoundResults();
        }, 35000); // 35 seconds (30 + 5 buffer)
    }

    endGame() {
        this.gameState = 'finished';

        const finalScores = {};
        this.scores.forEach((score, playerId) => {
            finalScores[playerId] = score;
        });

        this.broadcast({
            type: 'gameEnded',
            scores: finalScores
        });
    }

    reset() {
        this.gameState = 'lobby';
        this.answers.clear();
        this.currentRound = 0;
        this.scores.clear();
        this.votes.clear();
        this.currentRoundData = null;

        if (this.roundTimer) {
            clearTimeout(this.roundTimer);
            this.roundTimer = null;
        }

        // Reset player states
        this.players.forEach(player => {
            player.ready = false;
            player.answered = false;
            this.scores.set(player.id, 0);
        });
    }
}

// Create game room
const gameRoom = new GameRoom();

// Create HTTP server
const server = http.createServer();

// Create WebSocket server
const wss = new WebSocket.Server({ server });

// Handle WebSocket connections
wss.on('connection', (ws, req) => {
    console.log('New connection established');

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            handleMessage(ws, data);
        } catch (error) {
            console.error('Error parsing message:', error);
        }
    });

    ws.on('close', () => {
        if (ws.playerId) {
            console.log(`Player ${ws.playerId} disconnected`);
            gameRoom.removePlayer(ws.playerId);

            // Notify other players
            gameRoom.broadcast({
                type: 'playerLeft',
                players: gameRoom.getPlayersData()
            });
        }
    });

    ws.on('error', (error) => {
        console.error('WebSocket error:', error);
    });
});

function handleMessage(ws, data) {
    console.log(`Received message: ${data.type} from player ${ws.playerId}`); // Debug log

    switch (data.type) {
        case 'join':
            if (gameRoom.players.size >= 10) {
                ws.send(JSON.stringify({
                    type: 'error',
                    message: 'Game is full (10 players max)'
                }));
                return;
            }

            const player = gameRoom.addPlayer(ws, data.name);

            // Send confirmation to player
            ws.send(JSON.stringify({
                type: 'playerJoined',
                player: {
                    id: player.id,
                    name: player.name,
                    isHost: player.isHost
                },
                players: gameRoom.getPlayersData()
            }));

            // Notify other players
            gameRoom.broadcast({
                type: 'playerJoined',
                player: {
                    id: player.id,
                    name: player.name,
                    isHost: player.isHost
                },
                players: gameRoom.getPlayersData()
            }, player.id);

            console.log(`Player ${player.name} joined (${gameRoom.players.size}/10)`);
            break;

        case 'startQuestions':
            if (ws.playerId === gameRoom.hostId) {
                gameRoom.startQuestions(data.totalRounds || 10);
                console.log('Questions phase started');
            }
            break;

        case 'questionAnswered':
            gameRoom.submitAnswer(ws.playerId, data.questionIndex, data.answer);
            console.log(`Player ${ws.playerId} answered question ${data.questionIndex}`);
            break;

        case 'questionsCompleted':
            console.log(`Player ${ws.playerId} completed questions. Current ready players:`,
                Array.from(gameRoom.players.values()).filter(p => p.ready).length);

            gameRoom.markPlayerReady(ws.playerId);

            // Debug: Show how many players are ready vs total
            const readyPlayers = Array.from(gameRoom.players.values()).filter(p => p.ready).length;
            const totalPlayers = gameRoom.players.size;
            console.log(`Ready players: ${readyPlayers}/${totalPlayers}`);

            // Debug: Show current game state
            console.log('Current game state:', gameRoom.gameState);
            break;

        case 'startGame':
            console.log(`Start game request from ${ws.playerId}, is host: ${ws.playerId === gameRoom.hostId}`);
            console.log('Current game state:', gameRoom.gameState);

            if (ws.playerId === gameRoom.hostId) {
                const started = gameRoom.startGame();
                if (started) {
                    console.log('Game started by host');
                } else {
                    console.log('Failed to start game - not ready. Current state:', gameRoom.gameState);
                    ws.send(JSON.stringify({
                        type: 'error',
                        message: 'Game not ready to start'
                    }));
                }
            } else {
                console.log('Non-host tried to start game');
            }
            break;

        case 'vote':
            gameRoom.submitVote(ws.playerId, data.votedFor);
            console.log(`Player ${ws.playerId} voted for ${data.votedFor}`);
            break;

        case 'nextRound':
            // Round progression is handled automatically
            break;

        case 'playAgain':
            if (ws.playerId === gameRoom.hostId) {
                gameRoom.reset();
                gameRoom.broadcast({
                    type: 'gameReset',
                    players: gameRoom.getPlayersData()
                });
                console.log('Game reset for new round');
            }
            break;

        default:
            console.log('Unknown message type:', data.type);
    }
}

// Health check endpoint
server.on('request', (req, res) => {
    const pathname = url.parse(req.url).pathname;

    if (pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 'healthy',
            players: gameRoom.players.size,
            gameState: gameRoom.gameState,
            currentRound: gameRoom.currentRound
        }));
    } else {
        res.writeHead(404);
        res.end('Not Found');
    }
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`WebSocket server running on port ${PORT}`);
    console.log(`Health check available at http://localhost:${PORT}/health`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down gracefully');
    server.close(() => {
        console.log('Process terminated');
    });
});

process.on('SIGINT', () => {
    console.log('SIGINT received, shutting down gracefully');
    server.close(() => {
        console.log('Process terminated');
    });
});

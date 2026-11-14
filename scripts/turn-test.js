// Servidor TURN local só para testes (scripts/test-local.sh com TURN=1).
// Requer: npm i --no-save node-turn   (fica fora das dependências do projeto de propósito)
const Turn = require('node-turn');
new Turn({ listeningPort: 3478, listeningIps: ['127.0.0.1'], relayIps: ['127.0.0.1'], authMech: 'long-term', credentials: { teste: "teste" } }).start();
setInterval(() => {}, 1000);

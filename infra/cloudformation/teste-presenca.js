/**
 * Valida contra o servidor REAL os dois bugs de presenca corrigidos no P1:
 *   1. o disconnect atrasado de um socket antigo apagava o socket novo
 *   2. leaveRoom derrubava a presenca global, nao so a sala
 */
const { io } = require("socket.io-client");

const URL = process.argv[2] || "https://teste.web-socket-mundorevalida.com";
const ALUNO = "99001";
const OBSERVADOR = "99002";

const conectar = (userId) =>
    new Promise((resolve, reject) => {
        const s = io(URL, { auth: { user_id: userId }, transports: ["websocket"] });
        s.on("connect", () => resolve(s));
        s.on("connect_error", reject);
        setTimeout(() => reject(new Error("timeout conectando " + userId)), 15000);
    });

const quemEstaOnline = (socket) =>
    new Promise((resolve, reject) => {
        socket.emit("usersOnline");
        socket.once("usersOnlineReceived", (d) => resolve(d.users || {}));
        setTimeout(() => reject(new Error("timeout usersOnline")), 10000);
    });

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

let falhas = 0;
function checar(nome, ok, detalhe) {
    console.log(`${ok ? "  OK  " : " FALHA"}  ${nome}${detalhe ? " -> " + detalhe : ""}`);
    if (!ok) falhas++;
}

(async () => {
    console.log(`Alvo: ${URL}\n`);

    const observador = await conectar(OBSERVADOR);
    const alunoSocket1 = await conectar(ALUNO);
    await espera(500);

    let online = await quemEstaOnline(observador);
    checar("aluno aparece online para o outro", !!online[ALUNO], `socket=${online[ALUNO]}`);

    // --- Bug 1: race do socket antigo ---
    console.log("\n[cenario] aluno reconecta: socket novo entra, socket antigo cai depois");
    const alunoSocket2 = await conectar(ALUNO);
    await espera(500);
    alunoSocket1.disconnect(); // o socket ANTIGO cai por ultimo
    await espera(2500);

    online = await quemEstaOnline(observador);
    checar(
        "aluno CONTINUA online apos o socket antigo cair",
        !!online[ALUNO],
        online[ALUNO] ? `socket=${online[ALUNO]}` : "sumiu da lista (bug da race)",
    );

    // --- Bug 2: leaveRoom nao pode derrubar a presenca ---
    console.log("\n[cenario] aluno entra numa sala de treinamento e sai dela");
    alunoSocket2.emit("joinRoom", { training: "sala-de-teste-99", id: OBSERVADOR });
    await espera(1000);
    alunoSocket2.emit("leaveRoom", "sala-de-teste-99");
    await espera(1500);

    online = await quemEstaOnline(observador);
    checar(
        "aluno CONTINUA online depois de sair da sala",
        !!online[ALUNO],
        online[ALUNO] ? `socket=${online[ALUNO]}` : "sumiu da lista (bug do leaveRoom)",
    );

    // --- Sanidade: ao cair de vez, tem que sumir ---
    console.log("\n[cenario] aluno fecha a ultima conexao");
    alunoSocket2.disconnect();
    await espera(2500);
    online = await quemEstaOnline(observador);
    checar("aluno fica offline quando nao sobra conexao", !online[ALUNO]);

    observador.disconnect();
    console.log(falhas === 0 ? "\nTODOS OS CENARIOS PASSARAM" : `\n${falhas} CENARIO(S) FALHARAM`);
    process.exit(falhas === 0 ? 0 : 1);
})().catch((e) => {
    console.error("erro:", e.message);
    process.exit(1);
});

# Ambiente de teste do WebSocket

Stack CloudFormation que sobe um ambiente de teste **paralelo e isolado** do servidor WebSocket de treinamento, em `https://teste.web-socket-mundorevalida.com`.

Serve para validar os itens do P2 (idle timeout alto, ALB no lugar do Classic ELB, access logs, SSM) e as correções de presença/reconexão, sem encostar na produção.

## O que a produção tem hoje, e o que muda aqui

| | Produção | Teste |
|---|---|---|
| Load balancer | Classic ELB `ws-mundorevalida` | **ALB** |
| Idle timeout | 60s | **3600s** |
| Access logs | desligados | **ligados** (S3) |
| SSM Session Manager | indisponível | **habilitado** |
| Porta 3000 | aberta em `0.0.0.0/0` | **só a partir do ALB** |
| SSH | aberto em `0.0.0.0/0` | **restrito a um IP** |
| IMDS | v1 permitido | **IMDSv2 obrigatório** |
| Disco | não criptografado | **criptografado** |
| TLS | `ELBSecurityPolicy-2016-08` | **TLS 1.3 / 1.2** |

## Isolamento

O change set cria **15 recursos, todos `Add`** — nenhum `Modify`, nenhum `Remove`. Nada de produção é alterado.

Recursos de produção apenas **compartilhados e somente-leitura**: a VPC default, duas subnets públicas (us-east-1a e 1b, diferentes das 1d/1e usadas pela produção), o par de chaves `websocket-server`, e a zona Route53 — onde o stack apenas **adiciona** o registro do subdomínio e o CNAME de validação do ACM. Os registros do apex não são tocados.

As invariantes de isolamento estão codificadas em `websocket-teste.guard` e são verificadas por `cfn-guard`.

## Validação antes de subir

```bash
cfn-lint  websocket-teste.yaml
cfn-guard validate --rules websocket-teste.guard --data websocket-teste.yaml --show-summary all
aws cloudformation validate-template --template-body file://websocket-teste.yaml
```

## Deploy do stack

O parâmetro `NodeVersion` já vem com **18.17.1**, a versão exata da produção (conferida com `node -v`). O Node é instalado do tarball oficial de `nodejs.org` com o checksum verificado contra o `SHASUMS256.txt`, e não via NodeSource: o Node 18 saiu de suporte e o `setup_18.x` deixou de ser confiável.

Se a produção for atualizada, confira de novo e ajuste o parâmetro:

```bash
ssh -i ~/.ssh/websocket-server.pem ubuntu@44.196.233.187 'node -v'
```

```bash
aws cloudformation create-change-set \
  --stack-name websocket-teste \
  --change-set-name revisao-inicial \
  --change-set-type CREATE \
  --template-body file://websocket-teste.yaml \
  --capabilities CAPABILITY_IAM \
  --region us-east-1

# revise o que será criado
aws cloudformation describe-change-set \
  --stack-name websocket-teste --change-set-name revisao-inicial \
  --query 'Changes[].ResourceChange.{Acao:Action,Tipo:ResourceType,Id:LogicalResourceId}' \
  --output table --region us-east-1

# execute
aws cloudformation execute-change-set \
  --stack-name websocket-teste --change-set-name revisao-inicial --region us-east-1

aws cloudformation wait stack-create-complete --stack-name websocket-teste --region us-east-1
```

A criação leva alguns minutos e **fica parada no certificado ACM** até a validação DNS concluir. Isso é esperado.

```bash
aws cloudformation describe-stacks --stack-name websocket-teste \
  --query 'Stacks[0].Outputs' --output table --region us-east-1
```

## Deploy da aplicação (manual)

O stack prepara a máquina mas **não** instala o código: `/opt/websocket` fica vazio e o serviço systemd `websocket` fica criado e parado.

```bash
ssh -i ~/.ssh/websocket-server.pem ubuntu@<InstancePublicIp>
# ou, se o seu IP mudar:
aws ssm start-session --target <InstanceId> --region us-east-1
```

Na máquina:

> **Atenção ao ponto final no `git clone`.** Sem ele o git cria `/opt/websocket/websocket/`, e o systemd procura `/opt/websocket/dist/main` — o serviço entra em loop de restart com `Cannot find module '/opt/websocket/dist/main'`.

```bash
cd /opt/websocket
git clone https://github.com/tecnologiaMundoRevalida/websocket.git .   # <-- o "." importa
git checkout fix/presenca-e-reconexao

npm ci
npm run build

sudo systemctl enable --now websocket
systemctl status websocket
```

Se já tiver clonado na pasta aninhada por engano:

```bash
sudo systemctl stop websocket
cd /opt/websocket/websocket
shopt -s dotglob nullglob
sudo mv -- * /opt/websocket/
cd /opt/websocket && sudo rmdir websocket
sudo chown -R ubuntu:ubuntu /opt/websocket
sudo systemctl start websocket
```

O repositório é privado. Se o `git clone` pedir credencial, use um token de acesso pessoal ou copie do seu micro:

```bash
rsync -av --exclude node_modules --exclude .git \
  -e "ssh -i ~/.ssh/websocket-server.pem" \
  ./ ubuntu@<InstancePublicIp>:/opt/websocket/
```

### Conferir

```bash
# na máquina
curl -s localhost:3000            # Hello World!
journalctl -u websocket -f

# de fora
curl -s https://teste.web-socket-mundorevalida.com/
curl -s "https://teste.web-socket-mundorevalida.com/socket.io/?EIO=4&transport=polling"
```

O health check do target group usa `GET /`, que responde `200 Hello World!`.

### Apontar o front para o ambiente de teste

No `area-aluno-v2`, em `.env.local`:

```
NEXT_PUBLIC_WEBSOCKET_URL="https://teste.web-socket-mundorevalida.com"
```

## Access logs

O ALB entrega em `s3://<AccessLogsBucket>/AWSLogs/605874387561/elasticloadbalancing/us-east-1/`. Ao habilitar, o ELB grava um `ELBAccessLogTestFile` — é assim que se confirma que a policy do bucket está certa.

O bucket usa **SSE-S3 obrigatoriamente**: o ALB não entrega logs em bucket com SSE-KMS.

## Derrubar o ambiente

```bash
aws cloudformation delete-stack --stack-name websocket-teste --region us-east-1
```

O bucket de logs tem `DeletionPolicy: Retain` e **sobrevive** à exclusão do stack, junto com os logs. Apague à mão se não precisar mais.

Antes de excluir, vale desligar os access logs no ALB: se depois surgir um bucket de mesmo nome em outra conta, o ELB poderia passar a escrever nele.

## Custo aproximado

Cerca de **US$ 33 a 35/mês**: ALB ~US$ 17 (base, mais LCU), t3.small ~US$ 15, EBS 20 GB gp3 ~US$ 1,60. ACM é gratuito; S3 e Route53 ficam em centavos neste volume.

Se o ambiente for usado só em janelas de teste, dá para parar a instância e apagar o stack entre elas.

## Teste de regressão da presença

`teste-presenca.js` valida, contra o servidor rodando, os dois bugs de presença corrigidos no P1: a race do socket antigo apagando o novo, e o `leaveRoom` derrubando a presença global.

```bash
cd infra/cloudformation
node teste-presenca.js https://teste.web-socket-mundorevalida.com
```

Precisa do `socket.io-client` disponível (rode a partir de um projeto que já o tenha, ou `npm i socket.io-client`).

Resultado esperado no ambiente de teste: os quatro cenários passam.

> **Não aponte este script para produção sem trocar os IDs.** Ele usa `99001` e `99002`; se existir aluno real com um desses IDs, o servidor antigo — que guarda um socket por usuário — sobrescreveria a presença dele e a apagaria no disconnect, deixando um aluno real offline. Contra produção, use IDs impossíveis de colidir, como strings aleatórias.

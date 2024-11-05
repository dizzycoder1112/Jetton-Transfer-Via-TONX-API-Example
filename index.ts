import { Address, beginCell, Cell, external, internal, SendMode, StateInit, storeMessage, storeMessageRelaxed, toNano } from "@ton/core";
import { KeyPair, mnemonicToPrivateKey, sign } from "@ton/crypto";
import { WalletContractV4, WalletContractV5R1 } from "@ton/ton";
import { TONXJsonRpcProvider } from "@tonx/core"

enum WalletType {
  V4 = 0,
  V5 = 1
}
enum OPS {
  // Transfer = 0xf8a7ea5,
  // Transfer_notification = 0x7362d09c,
  // Internal_transfer = 0x178d4519,
  // Excesses = 0xd53276db,
  // Burn = 0x595f07bc,
  // Burn_notification = 0x7bdd97de,
  // ClaimRewards = 0x5a3e000,
  // ClaimRewardsNotification = 0x5a3e001,
  Mint = 21,
  InternalTransfer = 0x178d4519,
  Transfer = 0xf8a7ea5,
}

function createJettonTransferBody(toOwnerAddress: Address, jettonValue: bigint): Cell {
  return beginCell()
    .storeUint(OPS.Transfer, 32)
    .storeUint(0, 64) // queryid
    .storeCoins(jettonValue)
    .storeAddress(toOwnerAddress)
    .storeAddress(null)
    .storeDict(null) // custom payload
    .storeCoins(0) // forward ton amount
    .storeMaybeRef(null) // forward payload
    .endCell();
}

export class Wallet {
  contract: WalletContractV4 | WalletContractV5R1
  keyPair: KeyPair

  constructor(keyPair: KeyPair, walletType = WalletType.V4) {
    switch (walletType) {
      case WalletType.V4:
        this.contract = WalletContractV4.create({
          workchain: 0,
          publicKey: keyPair.publicKey,
        })
        this.keyPair = keyPair
        break
      case WalletType.V5:
        this.contract = WalletContractV5R1.create({
          workchain: 0,
          publicKey: keyPair.publicKey,
        })
        this.keyPair = keyPair
        break
      default:
        throw new Error('Invalid wallet type')
    }
  }

  static async init(mnemonic: string[], walletType = WalletType.V4) {
    try {
      const keyPair = await mnemonicToPrivateKey(mnemonic)

      return new Wallet(keyPair, walletType)
    }
    catch (error) {
      throw new Error('wallet init failed')
    }
  }

  async getSeqno(client: TONXJsonRpcProvider) {
    const response = await client.runGetMethod({
      address: this.contract.address.toString(),
      method:'seqno',
      stack: []
    })
    const seqnoHex = response.stack[0][1]
    const seqno = Number.parseInt(seqnoHex, 16)
    return seqno
  }

  async getSubWalletId(client: TONXJsonRpcProvider){
    const response = await client.runGetMethod({
      address: this.contract.address.toString(),
      method: 'get_subwallet_id',
      stack: []
    })
    const subWalletIdHex = response.stack[0][1];
    return parseInt(subWalletIdHex, 16);
  }

  async createExtMsgBoc(
    client: TONXJsonRpcProvider,
    intMsgParams: {
      toAddress: string
      value: string
      bounce?: boolean
      init?: StateInit
      body?: string | Cell
    },
    opCode = 0,
  ) {
    const { toAddress, value, init, bounce = true, body } = intMsgParams
    const intMsg = internal({
      to: Address.parse(toAddress), // Send TON to this address
      value: toNano(value),
      init,
      bounce,
      body,
    })
    const seqno = await this.getSeqno(client)
    const walletId = await this.getSubWalletId(client)
    const msg = beginCell()
      .storeUint(walletId, 32)
      .storeUint(0xFFFFFFFF, 32)
      .storeUint(seqno, 32)
      .storeUint(opCode, 8)
      .storeUint(SendMode.PAY_GAS_SEPARATELY, 8)
      .storeRef(beginCell().store(storeMessageRelaxed(intMsg)))

    const signedMsg = {
      builder: msg,
      cell: msg.endCell(),
    }
    const extMsgBody = beginCell()
      .storeBuffer(sign(signedMsg.cell.hash(), this.keyPair.secretKey))
      .storeBuilder(signedMsg.builder)
      .endCell()

    const extMsg = external({
      to: this.contract.address,
      init: this.contract.init,
      body: extMsgBody,
    })

    const extMsgCell = beginCell()
      .store(storeMessage(extMsg))
      .endCell()

    return {
      boc: extMsgCell.toBoc(),
      string: extMsgCell.toBoc().toString('base64'),
      message: extMsg,
      extMsgBody,
    }
  }
}



async function main () {
  const mnemonic = "enter your mnemonic here and split it by space"
  const reciverAddress = "enter reciver address here"
  const jettonWalletAddress = 'enter your jetton wallet address here'
  const client = new TONXJsonRpcProvider({
    network: 'testnet',
    apiKey: 'enter your tonx api key here'
  })
  
  const wallet = await Wallet.init(mnemonic.split(" "))
  const jettonValue = 100_000000n //value is 100 and decimal is 6;
  const body = createJettonTransferBody(Address.parse(reciverAddress), jettonValue);
  const internalMessage = {
    toAddress: jettonWalletAddress,
    value: '0.1',
    body
  }

  const extMag = await wallet.createExtMsgBoc(client, internalMessage)

  client.sendMessage(extMag.string)
}

main()
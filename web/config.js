// Brimstead web config: the ONE place for token, chain, addresses, ABI paths and links.
// golive.sh <CA> rewrites the `ca:` line below. Contract addresses are filled in by hand after the mainnet deploy.
// Chain reads go to the same-origin /rpc proxy (nginx → official RH mainnet RPC; needed for getLogs, publicnode prunes
// state). publicnode is the fallback for the read-only Chainlink price and the RPC handed to wallets.

export const CONFIG = {
  name: 'Brimstead',
  ticker: 'BRIM',
  domain: 'brimstead.xyz',
  url: 'https://brimstead.xyz',
  chainId: 4663,
  chainName: 'Robinhood Chain',
  readRpc: '/rpc', // same-origin proxy, used by the app for all reads
  rpc: 'https://robinhood-rpc.publicnode.com', // fallback for Chainlink price reads + wallet_addEthereumChain
  explorer: 'https://robinhoodchain.blockscout.com',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },

  ca: '',
  launchAt: '2026-11-12T17:00:00Z',
  buyUrl: (ca) => 'https://www.ponsfamily.com/launchpad/' + ca.toLowerCase(),
  creatorTaxPct: 2,

  links: {
    x: 'https://x.com/brimsteadxyz',
    xHandle: '@brimsteadxyz',
    repo: '', // public repo URL, empty = "to be announced"
  },

  contracts: {
    vault: '0x9599EA610B86d196A2F3E7a476735F9AA5622ABc', // BrimVault, RC mainnet, verified (Sourcify exact match)
    drip: '0x415E708435CA74a013b7E9E18B0C3fA79A61D429', // BrimDrip, RC mainnet, verified (Sourcify exact match)
    deployer: '0x8abB4cb1706DcE543CF21e7249eF97D913b6BBC7', // only power: BrimDrip.setToken, once
    deployBlock: 111488070, // L2 block of the first deploy tx (used to sum BrimDrip Claimed events)
  },

  // Fixed constants of the vault as written in contracts/src/BrimVault.sol (shown in docs; the app reads the
  // deployed values from the contract when the address is set).
  vaultRules: {
    maxFeeBps: 100,
    buyCutoffHours: 2, // buying closes 2 h before expiry
    minTenorDays: 1,
    maxTenorDays: 28,
    maxPriceAgeHours: 26, // write needs a Chainlink round no older than this
    buyPriceAgeDays: 4, // buy needs a round no older than this (the in-the-money check)
    closeMaxAgeHours: 26, // the Friday close round must be no older than this at expiry
    settleWindowDays: 4, // fallback earliest at expiry + this
    longStopDays: 30, // unconditional fallback after this
    dripDays: 7, // BrimDrip streams each ETH deposit linearly over this
  },

  // Robinhood stock tokens + Chainlink feeds (RC mainnet), same set as contracts/script/LaunchSet.sol.
  // Feeds price USD per raw token, 8 decimals.
  stocks: [
    { sym: 'NVDA', token: '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC', feed: '0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15' },
    { sym: 'TSLA', token: '0x322F0929c4625eD5bAd873c95208D54E1c003b2d', feed: '0x4A1166a659A55625345e9515b32adECea5547C38' },
    { sym: 'AAPL', token: '0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9', feed: '0x6B22A786bAa607d76728168703a39Ea9C99f2cD0' },
    { sym: 'SPY', token: '0x117cc2133c37B721F49dE2A7a74833232B3B4C0C', feed: '0x319724394D3A0e3669269846abE664Cd621f9f6A' },
    { sym: 'QQQ', token: '0xD5f3879160bc7c32ebb4dC785F8a4F505888de68', feed: '0x80901d846d5D7B030F26B480776EE3b29374C2ae' },
    { sym: 'MSFT', token: '0xe93237C50D904957Cf27E7B1133b510C669c2e74', feed: '0x45C3C877C15E6BA2EBB19eA114Ea508d14C1Af2E' },
    { sym: 'AMZN', token: '0x12f190a9F9d7D37a250758b26824B97CE941bF54', feed: '0xD5a1508ceD74c084eBf3cBe853e2C968fB2a651C' },
    { sym: 'GOOGL', token: '0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3', feed: '0xF6f373a037c30F0e5010d854385cA89185AE638b' },
    { sym: 'GLD', token: '0xC9a981FEE1F9DEc688bb123ccDeCc63D0deBFC4e', feed: '0x470A51258068043bd43dC0a56245625C9fE86eB0' },
    { sym: 'SPCX', token: '0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa', feed: '0xB265810950ba6c5C0Ff821c9963014a56fD8Bffb' },
    { sym: 'MSTR', token: '0xec262a75e413fAfD0dF80480274532C79D42da09', feed: '0x396118bdFB181e6240E74D243F266B061c0edc3D' },
  ],

  // ABIs: the real compiler output, copied from ../contracts/abi by web/scripts/sync-abi.sh.
  abis: { vault: '/abi/BrimVault.json', drip: '/abi/BrimDrip.json' },
};

export default CONFIG;

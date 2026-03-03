const { expect } = require('chai');
const { ethers } = require('hardhat');

const eth = (n) => ethers.utils.parseEther(String(n));
const State = {
  WaitingFinalization: 3,
  Rejected:            5,
};

describe('BUG 1 (fixed) – constructor rejects realtorFee that would cause underflow', () => {
  let realtor, seller, buyer;

  beforeEach(async () => {
    [realtor, seller, buyer] = await ethers.getSigners();
  });

  async function deploy(price, fee) {
    const Factory = await ethers.getContractFactory('HomeTransaction');
    return Factory.deploy(
      '1 Fixed Lane', '00001', 'Safecity',
      fee, price,
      realtor.address, seller.address, buyer.address
    );
  }

  it('constructor rejects realtorFee that exceeds 10% of price', async () => {
    await expect(deploy(eth('1'), eth('0.2'))).to.be.revertedWith(
      'Realtor fee cannot exceed the minimum deposit amount'
    );
  });

  it('constructor rejects realtorFee exactly equal to price', async () => {
    await expect(deploy(eth('1'), eth('1'))).to.be.revertedWith(
      'Realtor fee cannot exceed the minimum deposit amount'
    );
  });

  it('constructor accepts realtorFee that equals exactly 10% of price', async () => {
    await expect(deploy(eth('1'), eth('0.1'))).to.not.be.reverted;
  });

  it('withdrawal succeeds when realtorFee is at the boundary (equals min deposit)', async () => {
    const c = await deploy(eth('1'), eth('0.1'));
    await c.connect(seller).sellerSignContract();
    await c.connect(buyer).buyerSignContractAndPayDeposit({ value: eth('0.1') });
    await c.connect(realtor).realtorReviewedClosingConditions(true);

    const realtorBefore = await realtor.getBalance();
    await expect(c.connect(buyer).anyWithdrawFromTransaction()).to.not.be.reverted;
    expect(await c.contractState()).to.equal(State.Rejected);

    const realtorAfter = await realtor.getBalance();
    expect(realtorAfter.sub(realtorBefore)).to.equal(eth('0.1'));
  });
});

describe('BUG 2 (fixed) – realtor receives their fee when rejecting closing conditions', () => {
  let contract;
  let realtor, seller, buyer;

  const PRICE       = eth('1');
  const REALTOR_FEE = eth('0.05');
  const DEPOSIT     = eth('0.1');

  beforeEach(async () => {
    [realtor, seller, buyer] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory('HomeTransaction');
    contract = await Factory.deploy(
      '2 Fixed Ave', '00002', 'Feetown',
      REALTOR_FEE, PRICE,
      realtor.address, seller.address, buyer.address
    );
    await contract.connect(seller).sellerSignContract();
    await contract.connect(buyer).buyerSignContractAndPayDeposit({ value: DEPOSIT });
  });

  it('realtor receives their fee after rejecting', async () => {
    const realtorBefore = await realtor.getBalance();
    const tx = await contract.connect(realtor).realtorReviewedClosingConditions(false);
    const receipt = await tx.wait();
    const gasCost = receipt.gasUsed.mul(tx.gasPrice);
    const realtorAfter = await realtor.getBalance();

    const netGain = realtorAfter.add(gasCost).sub(realtorBefore);
    expect(netGain).to.equal(REALTOR_FEE);
  });

  it('buyer receives deposit minus realtorFee after rejection', async () => {
    const buyerBefore = await buyer.getBalance();
    await contract.connect(realtor).realtorReviewedClosingConditions(false);
    const buyerAfter = await buyer.getBalance();

    expect(buyerAfter.sub(buyerBefore)).to.be.closeTo(
      DEPOSIT.sub(REALTOR_FEE),
      eth('0.01')
    );
  });

  it('combined payout equals the full deposit', async () => {
    const contractBalance = await ethers.provider.getBalance(contract.address);
    expect(contractBalance).to.equal(DEPOSIT);

    const realtorBefore = await realtor.getBalance();
    const buyerBefore   = await buyer.getBalance();

    const tx = await contract.connect(realtor).realtorReviewedClosingConditions(false);
    const receipt = await tx.wait();
    const gasCost = receipt.gasUsed.mul(tx.gasPrice);

    const realtorGain = (await realtor.getBalance()).add(gasCost).sub(realtorBefore);
    const buyerGain   = (await buyer.getBalance()).sub(buyerBefore);

    expect(realtorGain.add(buyerGain)).to.equal(DEPOSIT);
  });
});

describe('BUG 3 (fixed) – integer truncation no longer allows sub-minimum deposits', () => {
  let contract;
  let realtor, seller, buyer;

  const PRICE_WEI = 99;
  const FEE_WEI   = 1;

  beforeEach(async () => {
    [realtor, seller, buyer] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory('HomeTransaction');
    contract = await Factory.deploy(
      '3 Fixed Blvd', '00003', 'Correctville',
      FEE_WEI, PRICE_WEI,
      realtor.address, seller.address, buyer.address
    );
    await contract.connect(seller).sellerSignContract();
  });

  it('rejects a zero deposit', async () => {
    await expect(
      contract.connect(buyer).buyerSignContractAndPayDeposit({ value: 0 })
    ).to.be.revertedWith('Buyer needs to deposit between 10% and 100% to sign contract');
  });

  it('rejects a deposit that would only pass the old truncated check (9 wei)', async () => {
    await expect(
      contract.connect(buyer).buyerSignContractAndPayDeposit({ value: 9 })
    ).to.be.revertedWith('Buyer needs to deposit between 10% and 100% to sign contract');
  });

  it('accepts the correct minimum deposit (10 wei) for a 99-wei property', async () => {
    await expect(
      contract.connect(buyer).buyerSignContractAndPayDeposit({ value: 10 })
    ).to.not.be.reverted;
    expect(await contract.deposit()).to.equal(10);
  });

  it('deposit is recorded as non-zero after a valid sign', async () => {
    await contract.connect(buyer).buyerSignContractAndPayDeposit({ value: 10 });
    expect(await contract.deposit()).to.be.gt(0);
  });
});

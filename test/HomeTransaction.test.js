const { expect } = require('chai');
const { ethers } = require('hardhat');

// Helpers
const eth = (n) => ethers.utils.parseEther(String(n));
const State = { WaitingSellerSignature: 0, WaitingBuyerSignature: 1, WaitingRealtorReview: 2, WaitingFinalization: 3, Finalized: 4, Rejected: 5 };

describe('HomeTransaction', () => {
  let contract;
  let realtor, seller, buyer, stranger;

  const PRICE = eth('1');           // 1 ETH
  const REALTOR_FEE = eth('0.05'); // 5%
  const DEPOSIT = eth('0.1');      // 10% — minimum valid deposit

  async function deploy(price = PRICE, fee = REALTOR_FEE) {
    const Factory = await ethers.getContractFactory('HomeTransaction');
    return Factory.deploy(
      '123 Main St', '90210', 'Beverly Hills',
      fee, price,
      realtor.address, seller.address, buyer.address
    );
  }

  beforeEach(async () => {
    [realtor, seller, buyer, stranger] = await ethers.getSigners();
    contract = await deploy();
  });

  // ─── Constructor ────────────────────────────────────────────────────────────

  describe('constructor', () => {
    it('sets all roles and details correctly', async () => {
      expect(await contract.realtor()).to.equal(realtor.address);
      expect(await contract.seller()).to.equal(seller.address);
      expect(await contract.buyer()).to.equal(buyer.address);
      expect(await contract.homeAddress()).to.equal('123 Main St');
      expect(await contract.zip()).to.equal('90210');
      expect(await contract.city()).to.equal('Beverly Hills');
      expect(await contract.price()).to.equal(PRICE);
      expect(await contract.realtorFee()).to.equal(REALTOR_FEE);
    });

    it('starts in WaitingSellerSignature state', async () => {
      expect(await contract.contractState()).to.equal(State.WaitingSellerSignature);
    });

    it('reverts when realtorFee exceeds price', async () => {
      await expect(deploy(eth('0.5'), eth('1'))).to.be.revertedWith(
        'Price needs to be more than realtor fee!'
      );
    });

    it('allows realtorFee equal to price', async () => {
      await expect(deploy(eth('1'), eth('1'))).to.not.be.reverted;
    });
  });

  // ─── sellerSignContract ──────────────────────────────────────────────────────

  describe('sellerSignContract', () => {
    it('transitions state to WaitingBuyerSignature', async () => {
      await contract.connect(seller).sellerSignContract();
      expect(await contract.contractState()).to.equal(State.WaitingBuyerSignature);
    });

    it('reverts when called by non-seller', async () => {
      await expect(contract.connect(buyer).sellerSignContract()).to.be.revertedWith(
        'Only seller can sign contract'
      );
      await expect(contract.connect(realtor).sellerSignContract()).to.be.revertedWith(
        'Only seller can sign contract'
      );
      await expect(contract.connect(stranger).sellerSignContract()).to.be.revertedWith(
        'Only seller can sign contract'
      );
    });

    it('reverts when called in the wrong state', async () => {
      await contract.connect(seller).sellerSignContract(); // now WaitingBuyerSignature
      await expect(contract.connect(seller).sellerSignContract()).to.be.revertedWith(
        'Wrong contract state'
      );
    });
  });

  // ─── buyerSignContractAndPayDeposit ─────────────────────────────────────────

  describe('buyerSignContractAndPayDeposit', () => {
    beforeEach(async () => {
      await contract.connect(seller).sellerSignContract();
    });

    it('accepts a 10% deposit and moves to WaitingRealtorReview', async () => {
      await contract.connect(buyer).buyerSignContractAndPayDeposit({ value: DEPOSIT });
      expect(await contract.contractState()).to.equal(State.WaitingRealtorReview);
      expect(await contract.deposit()).to.equal(DEPOSIT);
    });

    it('accepts the full price as deposit', async () => {
      await contract.connect(buyer).buyerSignContractAndPayDeposit({ value: PRICE });
      expect(await contract.contractState()).to.equal(State.WaitingRealtorReview);
    });

    it('sets finalizeDeadline after deposit', async () => {
      await contract.connect(buyer).buyerSignContractAndPayDeposit({ value: DEPOSIT });
      const deadline = await contract.finalizeDeadline();
      expect(deadline.toNumber()).to.be.greaterThan(0);
    });

    it('reverts when deposit is below 10%', async () => {
      const tooLow = eth('0.09');
      await expect(
        contract.connect(buyer).buyerSignContractAndPayDeposit({ value: tooLow })
      ).to.be.revertedWith('Buyer needs to deposit between 10% and 100% to sign contract');
    });

    it('reverts when deposit exceeds price', async () => {
      const tooHigh = eth('1.01');
      await expect(
        contract.connect(buyer).buyerSignContractAndPayDeposit({ value: tooHigh })
      ).to.be.revertedWith('Buyer needs to deposit between 10% and 100% to sign contract');
    });

    it('reverts when called by non-buyer', async () => {
      await expect(
        contract.connect(seller).buyerSignContractAndPayDeposit({ value: DEPOSIT })
      ).to.be.revertedWith('Only buyer can sign contract');
    });

    it('reverts in wrong state', async () => {
      await contract.connect(buyer).buyerSignContractAndPayDeposit({ value: DEPOSIT });
      await expect(
        contract.connect(buyer).buyerSignContractAndPayDeposit({ value: DEPOSIT })
      ).to.be.revertedWith('Wrong contract state');
    });
  });

  // ─── realtorReviewedClosingConditions ───────────────────────────────────────

  describe('realtorReviewedClosingConditions', () => {
    beforeEach(async () => {
      await contract.connect(seller).sellerSignContract();
      await contract.connect(buyer).buyerSignContractAndPayDeposit({ value: DEPOSIT });
    });

    it('accepted: transitions to WaitingFinalization', async () => {
      await contract.connect(realtor).realtorReviewedClosingConditions(true);
      expect(await contract.contractState()).to.equal(State.WaitingFinalization);
    });

    it('rejected: transitions to Rejected and refunds deposit to buyer', async () => {
      const balanceBefore = await buyer.getBalance();
      await contract.connect(realtor).realtorReviewedClosingConditions(false);

      expect(await contract.contractState()).to.equal(State.Rejected);
      const balanceAfter = await buyer.getBalance();
      expect(balanceAfter.sub(balanceBefore)).to.be.closeTo(DEPOSIT, eth('0.01'));
    });

    it('reverts when called by non-realtor', async () => {
      await expect(
        contract.connect(seller).realtorReviewedClosingConditions(true)
      ).to.be.revertedWith('Only realtor can review closing conditions');
      await expect(
        contract.connect(buyer).realtorReviewedClosingConditions(true)
      ).to.be.revertedWith('Only realtor can review closing conditions');
    });

    it('reverts in wrong state', async () => {
      await contract.connect(realtor).realtorReviewedClosingConditions(true);
      await expect(
        contract.connect(realtor).realtorReviewedClosingConditions(true)
      ).to.be.revertedWith('Wrong contract state');
    });
  });

  // ─── buyerFinalizeTransaction ────────────────────────────────────────────────

  describe('buyerFinalizeTransaction', () => {
    const remaining = PRICE.sub(DEPOSIT); // 0.9 ETH

    beforeEach(async () => {
      await contract.connect(seller).sellerSignContract();
      await contract.connect(buyer).buyerSignContractAndPayDeposit({ value: DEPOSIT });
      await contract.connect(realtor).realtorReviewedClosingConditions(true);
    });

    it('transitions to Finalized', async () => {
      await contract.connect(buyer).buyerFinalizeTransaction({ value: remaining });
      expect(await contract.contractState()).to.equal(State.Finalized);
    });

    it('pays seller (price - realtorFee) and realtor their fee', async () => {
      const sellerBefore = await seller.getBalance();
      const realtorBefore = await realtor.getBalance();

      const tx = await contract.connect(buyer).buyerFinalizeTransaction({ value: remaining });
      await tx.wait();

      const sellerAfter = await seller.getBalance();
      const realtorAfter = await realtor.getBalance();

      expect(sellerAfter.sub(sellerBefore)).to.equal(PRICE.sub(REALTOR_FEE));
      expect(realtorAfter.sub(realtorBefore)).to.equal(REALTOR_FEE);
    });

    it('reverts when payment is incorrect', async () => {
      await expect(
        contract.connect(buyer).buyerFinalizeTransaction({ value: eth('0.5') })
      ).to.be.revertedWith('Buyer needs to pay the rest of the cost to finalize transaction');
    });

    it('reverts when called by non-buyer', async () => {
      await expect(
        contract.connect(seller).buyerFinalizeTransaction({ value: remaining })
      ).to.be.revertedWith('Only buyer can finalize transaction');
    });

    it('reverts in wrong state', async () => {
      await contract.connect(buyer).buyerFinalizeTransaction({ value: remaining });
      await expect(
        contract.connect(buyer).buyerFinalizeTransaction({ value: remaining })
      ).to.be.revertedWith('Wrong contract state');
    });
  });

  // ─── anyWithdrawFromTransaction ─────────────────────────────────────────────

  describe('anyWithdrawFromTransaction', () => {
    beforeEach(async () => {
      await contract.connect(seller).sellerSignContract();
      await contract.connect(buyer).buyerSignContractAndPayDeposit({ value: DEPOSIT });
      await contract.connect(realtor).realtorReviewedClosingConditions(true);
    });

    it('buyer can withdraw before deadline', async () => {
      const sellerBefore = await seller.getBalance();
      const realtorBefore = await realtor.getBalance();

      await contract.connect(buyer).anyWithdrawFromTransaction();
      expect(await contract.contractState()).to.equal(State.Rejected);

      // seller receives deposit - realtorFee; realtor receives realtorFee
      const sellerAfter = await seller.getBalance();
      const realtorAfter = await realtor.getBalance();
      expect(sellerAfter.sub(sellerBefore)).to.equal(DEPOSIT.sub(REALTOR_FEE));
      expect(realtorAfter.sub(realtorBefore)).to.equal(REALTOR_FEE);
    });

    it('anyone can withdraw after the deadline passes', async () => {
      // Fast-forward past 5-minute deadline
      await ethers.provider.send('evm_increaseTime', [6 * 60]);
      await ethers.provider.send('evm_mine', []);

      await contract.connect(stranger).anyWithdrawFromTransaction();
      expect(await contract.contractState()).to.equal(State.Rejected);
    });

    it('reverts when a stranger tries to withdraw before deadline', async () => {
      await expect(
        contract.connect(stranger).anyWithdrawFromTransaction()
      ).to.be.revertedWith('Only buyer can withdraw before transaction deadline');
    });

    it('reverts in wrong state', async () => {
      await contract.connect(buyer).anyWithdrawFromTransaction();
      await expect(
        contract.connect(buyer).anyWithdrawFromTransaction()
      ).to.be.revertedWith('Wrong contract state');
    });
  });

  // ─── Full happy-path walkthrough ─────────────────────────────────────────────

  describe('full happy-path', () => {
    it('completes a transaction end-to-end', async () => {
      await contract.connect(seller).sellerSignContract();
      expect(await contract.contractState()).to.equal(State.WaitingBuyerSignature);

      await contract.connect(buyer).buyerSignContractAndPayDeposit({ value: DEPOSIT });
      expect(await contract.contractState()).to.equal(State.WaitingRealtorReview);

      await contract.connect(realtor).realtorReviewedClosingConditions(true);
      expect(await contract.contractState()).to.equal(State.WaitingFinalization);

      await contract.connect(buyer).buyerFinalizeTransaction({ value: PRICE.sub(DEPOSIT) });
      expect(await contract.contractState()).to.equal(State.Finalized);
    });
  });
});

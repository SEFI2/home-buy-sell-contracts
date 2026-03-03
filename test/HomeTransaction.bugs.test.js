/**
 * Bug-exposing tests for HomeTransaction.sol
 *
 * Each test below documents a real bug in the contract and is written to
 * assert the CORRECT expected behaviour. Because the bug exists, every test
 * in this file currently FAILS. Fix the contract to make them pass.
 *
 * Bug 1 – anyWithdrawFromTransaction: uint underflow when realtorFee > deposit
 * Bug 2 – realtorReviewedClosingConditions: realtor earns no fee on rejection
 * Bug 3 – buyerSignContractAndPayDeposit: integer truncation allows 0-wei deposit
 */

const { expect } = require('chai');
const { ethers } = require('hardhat');

const eth = (n) => ethers.utils.parseEther(String(n));
const State = {
  WaitingSellerSignature: 0,
  WaitingBuyerSignature:  1,
  WaitingRealtorReview:   2,
  WaitingFinalization:    3,
  Finalized:              4,
  Rejected:               5,
};

// ─────────────────────────────────────────────────────────────────────────────
// BUG 1
// Location : anyWithdrawFromTransaction(), line 116
// Code     : seller.transfer(deposit - realtorFee);
//
// The constructor only requires  price >= realtorFee.
// The deposit minimum is        price * 10 / 100  (10 %).
// When realtorFee > 10 % of price the subtraction underflows (Solidity 0.5.x
// has no checked arithmetic), wrapping to an astronomically large uint256.
// seller.transfer(wrapped_value) reverts because the contract holds only
// `deposit` wei.  The transaction rolls back, the state stays at
// WaitingFinalization, and the buyer's deposit is permanently locked.
// ─────────────────────────────────────────────────────────────────────────────
describe('BUG 1 – anyWithdrawFromTransaction underflow when realtorFee > deposit', () => {
  let contract;
  let realtor, seller, buyer;

  // price = 1 ETH  →  realtorFee = 0.2 ETH (20 %) is valid per constructor.
  // Minimum deposit = 10 % of 1 ETH = 0.1 ETH  <  realtorFee (0.2 ETH).
  const PRICE       = eth('1');
  const REALTOR_FEE = eth('0.2'); // 20% — valid since price >= realtorFee
  const DEPOSIT     = eth('0.1'); // 10% minimum — valid but less than realtorFee

  beforeEach(async () => {
    [realtor, seller, buyer] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory('HomeTransaction');
    contract = await Factory.deploy(
      '1 Bug Lane', '00001', 'Underflow City',
      REALTOR_FEE, PRICE,
      realtor.address, seller.address, buyer.address
    );
    await contract.connect(seller).sellerSignContract();
    await contract.connect(buyer).buyerSignContractAndPayDeposit({ value: DEPOSIT });
    await contract.connect(realtor).realtorReviewedClosingConditions(true);
    // Contract is now in WaitingFinalization with 0.1 ETH on-chain.
  });

  it('FAILS: buyer withdraw should succeed when realtorFee exceeds deposit', async () => {
    // Correct behaviour: withdrawal should complete and distribute funds.
    // Actual behaviour: deposit(0.1) - realtorFee(0.2) underflows → revert.
    await expect(
      contract.connect(buyer).anyWithdrawFromTransaction()
    ).to.not.be.reverted; // ← FAILS (contract reverts due to underflow)
  });

  it('FAILS: seller should receive deposit minus realtorFee after buyer withdraws', async () => {
    const sellerBefore = await seller.getBalance();

    // This call itself reverts (underflow), so balances never change.
    try { await contract.connect(buyer).anyWithdrawFromTransaction(); } catch (_) {}

    const sellerAfter = await seller.getBalance();
    // Correct: seller gets deposit - realtorFee = 0.1 - 0.2 … but that's negative,
    // exposing the deeper design issue: the contract should guard against this.
    // For now the test proves the seller received nothing.
    expect(sellerAfter).to.be.gt(sellerBefore); // ← FAILS (seller balance unchanged)
  });

  it('FAILS: contract state should be Rejected after withdrawal attempt', async () => {
    // Because the transfer reverts, the entire transaction is rolled back.
    // The state remains WaitingFinalization — the deposit is effectively frozen.
    try { await contract.connect(buyer).anyWithdrawFromTransaction(); } catch (_) {}

    // Correct behaviour: state should have moved to Rejected.
    expect(await contract.contractState()).to.equal(State.Rejected); // ← FAILS (still WaitingFinalization)
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// BUG 2
// Location : realtorReviewedClosingConditions(), line 92
// Code     : buyer.transfer(deposit);   // rejection branch
//
// When the realtor rejects closing conditions the full deposit is returned to
// the buyer.  The realtor receives nothing despite having performed the review.
// Compare the acceptance path (buyer finalises → realtor.transfer(realtorFee))
// and the withdrawal path (anyWithdrawFromTransaction →
// realtor.transfer(realtorFee)): the realtor is paid in every other outcome
// except when *they* reject the deal.  This breaks the economic incentive to
// reject, and fails to compensate the realtor for their services.
// ─────────────────────────────────────────────────────────────────────────────
describe('BUG 2 – realtor receives no fee when they reject closing conditions', () => {
  let contract;
  let realtor, seller, buyer;

  const PRICE       = eth('1');
  const REALTOR_FEE = eth('0.05');
  const DEPOSIT     = eth('0.1');

  beforeEach(async () => {
    [realtor, seller, buyer] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory('HomeTransaction');
    contract = await Factory.deploy(
      '2 Bug Ave', '00002', 'Nofeeville',
      REALTOR_FEE, PRICE,
      realtor.address, seller.address, buyer.address
    );
    await contract.connect(seller).sellerSignContract();
    await contract.connect(buyer).buyerSignContractAndPayDeposit({ value: DEPOSIT });
  });

  it('FAILS: realtor should receive their fee when rejecting closing conditions', async () => {
    const realtorBefore = await realtor.getBalance();
    const tx = await contract.connect(realtor).realtorReviewedClosingConditions(false);
    const receipt = await tx.wait();
    const gasCost = receipt.gasUsed.mul(tx.gasPrice);
    const realtorAfter = await realtor.getBalance();

    // Correct: realtor should have gained realtorFee (minus gas).
    // Actual:  buyer.transfer(deposit) gives everything to buyer; realtor gets nothing.
    const netGain = realtorAfter.add(gasCost).sub(realtorBefore);
    expect(netGain).to.equal(REALTOR_FEE); // ← FAILS (netGain ≈ 0 - gas)
  });

  it('FAILS: buyer should receive deposit minus realtorFee when realtor rejects', async () => {
    const buyerBefore = await buyer.getBalance();
    await contract.connect(realtor).realtorReviewedClosingConditions(false);
    const buyerAfter = await buyer.getBalance();

    // Correct: buyer should get back deposit - realtorFee (realtor keeps their cut).
    // Actual:  buyer gets the full deposit back (deposit - 0 = deposit).
    const expectedRefund = DEPOSIT.sub(REALTOR_FEE);
    expect(buyerAfter.sub(buyerBefore)).to.be.closeTo(expectedRefund, eth('0.01')); // ← FAILS (buyer gets full DEPOSIT)
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// BUG 3
// Location : buyerSignContractAndPayDeposit(), line 72
// Code     : msg.value >= price * depositPercentage / 100
//
// Solidity integer division truncates towards zero.  For any price < 10 the
// expression evaluates to 0, so the require allows msg.value = 0 and the buyer
// signs with no deposit at all.  Downstream this means:
//   • anyWithdrawFromTransaction: deposit(0) - realtorFee underflows.
//   • buyerFinalizeTransaction:   msg.value + 0 == price → buyer pays full
//     price at finalization with no skin in the game beforehand.
// The contract's deposit requirement is completely bypassed.
// ─────────────────────────────────────────────────────────────────────────────
describe('BUG 3 – integer truncation allows zero deposit for small-price properties', () => {
  let contract;
  let realtor, seller, buyer;

  // price = 9 wei  →  9 * 10 / 100 = 0  in uint256 integer division.
  // A buyer can therefore pass msg.value = 0 and satisfy the require.
  const PRICE_WEI = 9;
  const FEE_WEI   = 1;

  beforeEach(async () => {
    [realtor, seller, buyer] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory('HomeTransaction');
    contract = await Factory.deploy(
      '3 Bug Blvd', '00003', 'Truncation Town',
      FEE_WEI, PRICE_WEI,
      realtor.address, seller.address, buyer.address
    );
    await contract.connect(seller).sellerSignContract();
  });

  it('FAILS: signing with zero deposit should be rejected', async () => {
    // Correct behaviour: a zero-value deposit violates the 10 % floor and should revert.
    // Actual behaviour:  9 * 10 / 100 = 0, so msg.value = 0 passes the check.
    await expect(
      contract.connect(buyer).buyerSignContractAndPayDeposit({ value: 0 })
    ).to.be.revertedWith('Buyer needs to deposit between 10% and 100% to sign contract'); // ← FAILS (no revert)
  });

  it('FAILS: contract deposit should be non-zero after buyer signs', async () => {
    // Even if the call somehow succeeds, the recorded deposit must be > 0.
    try {
      await contract.connect(buyer).buyerSignContractAndPayDeposit({ value: 0 });
    } catch (_) {}

    // Correct: deposit should reflect a real non-zero amount.
    expect(await contract.deposit()).to.be.gt(0); // ← FAILS (deposit = 0)
  });

  it('FAILS: 1-wei deposit should also be rejected for a 9-wei property', async () => {
    // 1 wei < ceil(10 % of 9 wei) = 1 wei — on the boundary but integer
    // truncation makes the floor 0, so 1 wei also passes when it should be
    // treated as the correct minimum instead of 0.
    // This test documents that the minimum is computed incorrectly.
    const correctMinimum = Math.ceil(PRICE_WEI * 10 / 100); // = 1 wei (correct)
    const contractMinimum = Math.floor(PRICE_WEI * 10 / 100); // = 0 wei (buggy)

    // The contract currently accepts 0 (buggy floor), but should require at least 1.
    expect(contractMinimum).to.equal(0);    // documents the bug
    expect(correctMinimum).to.equal(1);     // documents the fix
    // A 0-wei deposit must NOT be allowed — this assertion captures the requirement.
    await expect(
      contract.connect(buyer).buyerSignContractAndPayDeposit({ value: 0 })
    ).to.be.reverted; // ← FAILS
  });
});

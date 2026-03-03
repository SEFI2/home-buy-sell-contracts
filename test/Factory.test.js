const { expect } = require('chai');
const { ethers } = require('hardhat');

const eth = (n) => ethers.utils.parseEther(String(n));

describe('Factory', () => {
  let factory;
  let realtor, seller, buyer, stranger;

  const PRICE = eth('1');
  const FEE = eth('0.05');

  async function createViaFactory(price = PRICE, fee = FEE) {
    return factory.connect(realtor).create(
      '123 Main St', '90210', 'Beverly Hills',
      fee, price,
      seller.address, buyer.address
    );
  }

  beforeEach(async () => {
    [realtor, seller, buyer, stranger] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory('Factory');
    factory = await Factory.deploy();
  });

  describe('create', () => {
    it('deploys a HomeTransaction and appends it to the list', async () => {
      await createViaFactory();
      expect(await factory.getInstanceCount()).to.equal(1);
    });

    it('sets the caller (msg.sender) as realtor of the new contract', async () => {
      await createViaFactory();
      const instance = await factory.getInstance(0);
      const HomeTransaction = await ethers.getContractFactory('HomeTransaction');
      const htContract = HomeTransaction.attach(instance);
      expect(await htContract.realtor()).to.equal(realtor.address);
    });

    it('sets seller and buyer correctly on the new contract', async () => {
      await createViaFactory();
      const instance = await factory.getInstance(0);
      const HomeTransaction = await ethers.getContractFactory('HomeTransaction');
      const htContract = HomeTransaction.attach(instance);
      expect(await htContract.seller()).to.equal(seller.address);
      expect(await htContract.buyer()).to.equal(buyer.address);
    });

    it('sets property details correctly on the new contract', async () => {
      await createViaFactory();
      const instance = await factory.getInstance(0);
      const HomeTransaction = await ethers.getContractFactory('HomeTransaction');
      const htContract = HomeTransaction.attach(instance);
      expect(await htContract.homeAddress()).to.equal('123 Main St');
      expect(await htContract.zip()).to.equal('90210');
      expect(await htContract.city()).to.equal('Beverly Hills');
      expect(await htContract.price()).to.equal(PRICE);
      expect(await htContract.realtorFee()).to.equal(FEE);
    });

    it('accumulates multiple contracts', async () => {
      await createViaFactory();
      await createViaFactory();
      await createViaFactory();
      expect(await factory.getInstanceCount()).to.equal(3);
    });

    it('reverts when realtorFee exceeds price', async () => {
      await expect(createViaFactory(eth('0.5'), eth('1'))).to.be.revertedWith(
        'Price needs to be more than realtor fee!'
      );
    });

    it('different callers become different realtors', async () => {
      await factory.connect(realtor).create('A', '1', 'X', FEE, PRICE, seller.address, buyer.address);
      await factory.connect(stranger).create('B', '2', 'Y', FEE, PRICE, seller.address, buyer.address);

      const HomeTransaction = await ethers.getContractFactory('HomeTransaction');

      const ht0 = HomeTransaction.attach(await factory.getInstance(0));
      const ht1 = HomeTransaction.attach(await factory.getInstance(1));

      expect(await ht0.realtor()).to.equal(realtor.address);
      expect(await ht1.realtor()).to.equal(stranger.address);
    });
  });

  describe('getInstance', () => {
    it('returns the correct contract at a given index', async () => {
      await createViaFactory();
      const count = await factory.getInstanceCount();
      expect(count).to.equal(1);

      const instance = await factory.getInstance(0);
      expect(instance).to.be.properAddress;
    });

    it('reverts when index is out of range', async () => {
      await expect(factory.getInstance(0)).to.be.revertedWith('index out of range');

      await createViaFactory();
      await expect(factory.getInstance(1)).to.be.revertedWith('index out of range');
    });
  });

  describe('getInstances', () => {
    it('returns an empty array when no contracts exist', async () => {
      const instances = await factory.getInstances();
      expect(instances).to.deep.equal([]);
    });

    it('returns all deployed contract addresses', async () => {
      await createViaFactory();
      await createViaFactory();

      const instances = await factory.getInstances();
      expect(instances).to.have.length(2);
      instances.forEach((addr) => expect(addr).to.be.properAddress);
    });

    it('matches getInstance for each index', async () => {
      await createViaFactory();
      await createViaFactory();

      const all = await factory.getInstances();
      for (let i = 0; i < all.length; i++) {
        expect(all[i]).to.equal(await factory.getInstance(i));
      }
    });
  });

  describe('getInstanceCount', () => {
    it('returns 0 when no contracts exist', async () => {
      expect(await factory.getInstanceCount()).to.equal(0);
    });

    it('increments by 1 for each created contract', async () => {
      for (let i = 1; i <= 4; i++) {
        await createViaFactory();
        expect(await factory.getInstanceCount()).to.equal(i);
      }
    });
  });
});

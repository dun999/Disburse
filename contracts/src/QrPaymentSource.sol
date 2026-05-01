// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function transfer(address to, uint256 value) external returns (bool);
}

contract QrPaymentSource {
    event QrPaymentInitiated(
        bytes32 indexed requestId,
        address indexed payer,
        address indexed recipient,
        address token,
        uint256 amount,
        uint256 destinationChainId,
        uint256 nonce
    );

    address public owner;
    mapping(bytes32 => bool) public paidRequests;

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    function transferOwnership(address nextOwner) external onlyOwner {
        require(nextOwner != address(0), "invalid owner");
        owner = nextOwner;
    }

    function sweep(address token, address to, uint256 amount) external onlyOwner {
        require(token != address(0), "invalid token");
        require(to != address(0), "invalid recipient");
        require(IERC20(token).transfer(to, amount), "sweep failed");
    }

    function pay(
        bytes32 requestId,
        address recipient,
        address token,
        uint256 amount,
        uint256 destinationChainId,
        uint256 expiresAt,
        uint256 nonce
    ) external {
        require(requestId != bytes32(0), "invalid request");
        require(recipient != address(0), "invalid recipient");
        require(token != address(0), "invalid token");
        require(amount > 0, "invalid amount");
        require(destinationChainId != block.chainid, "same-chain route");
        require(block.timestamp <= expiresAt, "request expired");
        require(!paidRequests[requestId], "request already paid");

        paidRequests[requestId] = true;
        require(IERC20(token).transferFrom(msg.sender, address(this), amount), "transfer failed");

        emit QrPaymentInitiated(requestId, msg.sender, recipient, token, amount, destinationChainId, nonce);
    }
}

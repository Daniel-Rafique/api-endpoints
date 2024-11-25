#!/bin/bash

# Base directories
BASE_DIR=~/devnet-api
MAIN_DIR=$BASE_DIR/marketMaker
INSTANCES_DIR=$BASE_DIR/instances

# Check if main directory exists
if [ ! -d "$MAIN_DIR" ]; then
    echo "Error: Main directory $MAIN_DIR does not exist"
    exit 1
fi

# Check if .env.template exists
if [ ! -f "$MAIN_DIR/.env.template" ]; then
    echo "Error: .env.template not found in $MAIN_DIR"
    exit 1
fi

# Create directory structure
mkdir -p $INSTANCES_DIR

# List of strategies
strategies=("copytrade" "pumpfun" "moonshot" "raydium" "sniper" "sol_spl" "usdc_spl")

# Create symlinks for shared code and dependencies
for strategy in "${strategies[@]}"; do
    instance_dir="$INSTANCES_DIR/$strategy"
    
    # Create instance directory if it doesn't exist
    mkdir -p "$instance_dir"
    
    # Remove existing symlinks if they exist
    rm -f "$instance_dir/node_modules"
    rm -f "$instance_dir/dist"
    
    # Create symlinks to shared code and node_modules
    ln -s "$MAIN_DIR/node_modules" "$instance_dir/node_modules"
    ln -s "$MAIN_DIR/dist" "$instance_dir/dist"
    
    # Copy template .env and modify for instance
    cp "$MAIN_DIR/.env.template" "$instance_dir/.env"
    
    # Update TRADE_TYPE in the .env file
    sed -i "s/^TRADE_TYPE=.*$/TRADE_TYPE=$strategy/" "$instance_dir/.env"
    
    echo "Setup completed for $strategy with TRADE_TYPE=$strategy"
done

echo "All instances have been set up successfully"

# Verify .env files
echo "Verifying .env configurations..."
for strategy in "${strategies[@]}"; do
    instance_dir="$INSTANCES_DIR/$strategy"
    trade_type=$(grep "^TRADE_TYPE=" "$instance_dir/.env" | cut -d'=' -f2)
    if [ "$trade_type" = "$strategy" ]; then
        echo "✅ $strategy: TRADE_TYPE correctly set to $trade_type"
    else
        echo "❌ $strategy: TRADE_TYPE mismatch. Expected $strategy, got $trade_type"
    fi
done
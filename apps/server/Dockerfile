# Use an official Node.js runtime as a parent image
FROM node:18

# Set the working directory to /app
WORKDIR /app

# Copy the current directory contents into the container at /app
COPY . .

# Install pnpm globally
RUN curl -f https://get.pnpm.io/v6.16.js | node - add --global pnpm

# Set the working directory to apps/server
WORKDIR /app/apps/server

# Install dependencies
RUN pnpm install

# Build the project
RUN pnpm run build

# Make port 4000 available to the world outside this container
EXPOSE 4000

# Run the application
CMD ["pnpm", "start"]
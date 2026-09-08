FROM node:22-alpine
RUN apk add --no-cache ffmpeg
WORKDIR /app
COPY package.json server.mjs drawing.html double-slit.html ./
RUN mkdir -p .animation-output
EXPOSE 3000
CMD ["npm", "start"]
